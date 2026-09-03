import { ADMIN_GROUP, ADMIN_USER } from "../config/keel";
import { dedent, file, merge, script, type Tree } from "./tree";

export const KEEL_CONF = "/boot/efi/keel.conf";
/**
 * `/usr/bin`, not `/usr/lib/keel`. The unit runs in `unconfined_t` so it can read
 * the ESP, and entering that domain needs an entrypoint label the targeted policy
 * grants it: `/usr/bin` is `bin_t`, `/usr/lib/keel` is `lib_t` and is not one.
 */
export const FIRSTBOOT_PATH = "/usr/bin/keel-firstboot";
export const RANGES_PATH = "/etc/keel/nft.d/10-ranges.nft";

/**
 * The identity an image cannot hold, read off the card it boots from.
 *
 * `keel.conf` sits on the ESP, which is FAT: any machine can mount the card and
 * edit the file, with no Linux tooling and no loop mounts. That is what lets one
 * image boot every board — the hostname, the admin keys and the address ranges
 * the packet filter admits are properties of where a board is plugged in, not of
 * the OS it runs.
 *
 * Converge, not first boot: the unit runs every time, compares before it writes,
 * and a steady-state boot touches nothing under /etc. So correcting a typo is
 * editing the card and rebooting, and a card moved to another board makes that
 * board the host the card describes.
 *
 * The file is parsed, never sourced. It is removable media anyone holding the
 * card can write to, so a shell that executed it would hand them root; every
 * value is matched against a `case` pattern before it reaches a command, and an
 * unrecognised key is a log line rather than a variable.
 *
 * The trap the ESP sets, for anything else that ever reads from it: the targeted
 * policy grants `init_t` `getattr` on `dosfs_t` but not `read`. So a path on the
 * ESP *exists* to PID 1 and to any service left in `init_t` while its contents do
 * not — `test -e` succeeds, `test -r` fails, and a script that gates on the first
 * and then opens the file gets a card that reads as blank. Reaching the ESP means
 * leaving `init_t`, which is what `SELinuxContext` on the unit is for.
 */
function firstboot(): Tree {
  return script(
    FIRSTBOOT_PATH,
    dedent(`
      #!/bin/sh
      # Deliberately no \`set -e\`: a partial keel.conf applies what it has, and a
      # step with nothing to do is the normal case rather than a reason to stop.
      set -u

      conf=${KEEL_CONF}
      admin=${ADMIN_USER}
      group=${ADMIN_GROUP}
      ranges=${RANGES_PATH}

      # Two destinations, because they reach different readers. stdout is the
      # journal, where the detail belongs. /dev/kmsg is printk, and printk is the
      # only path from userspace to the serial console that stays open: systemd
      # stops mirroring unit output to the console once journald takes over, a
      # couple of seconds into the boot, so a board watched over a 3.3 V adapter
      # on GPIO 14/15 — or a QEMU run watching -serial — would otherwise never
      # see a word of this.
      say() {
          printf 'keel-firstboot: %s\\n' "$1"
          if [ -w /dev/kmsg ]; then printf 'keel-firstboot: %s\\n' "$1" > /dev/kmsg; fi
          return 0
      }

      # This runs in unconfined_t, which is what lets it read the ESP at all, and
      # an unconfined process does not inherit the file type transitions the
      # targeted policy defines for the paths below — /etc/hostname is
      # hostname_etc_t, an authorized_keys file ssh_home_t. Each is restored as it
      # is written, so the labels match what a relabel would produce.
      relabel() {
          if [ -x /usr/sbin/restorecon ]; then
              /usr/sbin/restorecon -RF "$1" >/dev/null 2>&1
          fi
          return 0
      }

      [ -r "$conf" ] || { say "no $conf — nothing to apply"; exit 0; }
      say "reading $conf"

      # Shape checks, so a value from removable media is never spliced into a
      # command on trust.
      is_v4_cidr() {
          case "$1" in
              *[!0-9./]*) return 1 ;;
              [0-9]*.[0-9]*.[0-9]*.[0-9]*/[0-9]*) return 0 ;;
              *) return 1 ;;
          esac
      }

      is_v6_cidr() {
          case "$1" in
              *[!0-9a-fA-F:./]*) return 1 ;;
              *:*:*/[0-9]*) return 0 ;;
              *) return 1 ;;
          esac
      }

      hostname=""
      lan4=""
      mesh4=""
      mesh6=""
      cr=$(printf '\\r')

      keyfile=$(mktemp) || exit 0
      trap 'rm -f "$keyfile"' EXIT

      # \`|| [ -n "$line" ]\` so a last line with no newline is still read: the
      # editor on the other machine decides that, and plenty do not add one.
      while IFS= read -r line || [ -n "$line" ]; do
          # Trailing CR, from an editor that writes DOS line endings onto a FAT
          # partition — which is most of them.
          line=\${line%"$cr"}
          case "$line" in
              ""|\\#*) continue ;;
              *=*) ;;
              *) say "ignoring line that is not KEY=value: $line"; continue ;;
          esac

          key=\${line%%=*}
          value=\${line#*=}

          case "$key" in
              KEEL_HOSTNAME)
                  case "$value" in
                      ""|*[!A-Za-z0-9-]*) say "ignoring KEEL_HOSTNAME '$value'" ;;
                      *) hostname=$value ;;
                  esac
                  ;;
              KEEL_ADMIN_KEY)
                  # Repeatable: one line per key, every key that parses is
                  # admitted, so a second machine is added by adding a line.
                  case "$value" in
                      ssh-*) printf '%s\\n' "$value" >> "$keyfile" ;;
                      *) say "ignoring KEEL_ADMIN_KEY that is not an ssh key" ;;
                  esac
                  ;;
              KEEL_LAN_CIDR)
                  if is_v4_cidr "$value"; then lan4=$value
                  else say "ignoring KEEL_LAN_CIDR '$value'"; fi
                  ;;
              KEEL_MESH_V4)
                  if is_v4_cidr "$value"; then mesh4=$value
                  else say "ignoring KEEL_MESH_V4 '$value'"; fi
                  ;;
              KEEL_MESH_V6)
                  if is_v6_cidr "$value"; then mesh6=$value
                  else say "ignoring KEEL_MESH_V6 '$value'"; fi
                  ;;
              *)
                  say "ignoring unknown key $key"
                  ;;
          esac
      done < "$conf"

      # --- hostname -----------------------------------------------------------
      if [ -n "$hostname" ] && [ "$(cat /etc/hostname 2>/dev/null)" != "$hostname" ]; then
          printf '%s\\n' "$hostname" > /etc/hostname
          relabel /etc/hostname
          # The running kernel too, so this boot's own logs carry the name.
          printf '%s\\n' "$hostname" > /proc/sys/kernel/hostname
          say "hostname is $hostname"
      fi

      # --- the admin account --------------------------------------------------
      # The group is the grant: sshd admits it and the image's sudoers drop-in
      # gives it root, so an account outside it exists and cannot log in. Hence
      # membership is converged and not only set at creation: no account on this
      # image has a usable password, so a login prompt on a screen cannot be
      # satisfied, and this pass — reached by editing the card on any laptop and
      # rebooting — is the only thing that puts a member back.
      if ! id -u "$admin" >/dev/null 2>&1; then
          useradd -m -G "$group" "$admin" && say "created $admin in $group"
      elif ! id -nG "$admin" 2>/dev/null | tr ' ' '\\n' | grep -qx "$group"; then
          usermod -aG "$group" "$admin" && say "added $admin to $group"
      fi

      # --- the keys that get in -----------------------------------------------
      if [ -s "$keyfile" ]; then
          home=$(getent passwd "$admin" | cut -d: -f6)
          if [ -z "$home" ]; then
              say "no home directory for $admin — keys not installed"
          elif ! cmp -s "$keyfile" "$home/.ssh/authorized_keys"; then
              mkdir -p "$home/.ssh"
              chmod 700 "$home/.ssh"
              chown "$admin" "$home/.ssh"
              install -m 600 -o "$admin" "$keyfile" "$home/.ssh/authorized_keys"
              relabel "$home/.ssh"
              say "installed $(wc -l < "$keyfile" | tr -d ' ') admin key(s)"
          fi
      fi

      # --- the ranges the packet filter admits --------------------------------
      # Re-declaring a set adds to it, so this file names ranges and restates
      # nothing: nft merges these elements into the table the image ships.
      if [ -n "$lan4" ] || [ -n "$mesh4" ] || [ -n "$mesh6" ]; then
          mkdir -p "$(dirname "$ranges")"
          tmp=$(mktemp "$ranges.XXXXXX") || exit 0
          {
              echo "table inet keel {"
              [ -n "$lan4" ] && echo "    set lan4 { type ipv4_addr; flags interval; elements = { $lan4 } }"
              [ -n "$mesh4" ] && echo "    set mesh4 { type ipv4_addr; flags interval; elements = { $mesh4 } }"
              [ -n "$mesh6" ] && echo "    set mesh6 { type ipv6_addr; flags interval; elements = { $mesh6 } }"
              echo "}"
          } > "$tmp"
          # The globs above check shape, not validity — nft is the real parser,
          # and a file it rejects would fail nftables.service, a required unit,
          # turning a typo on the card into a failed boot. Checked here instead:
          # a bad range is a log line and a still-closed filter.
          if ! nft -c -f "$tmp" >/dev/null 2>&1; then
              say "ranges rejected by nft -c — not applied"
              rm -f "$tmp"
          elif cmp -s "$tmp" "$ranges"; then
              rm -f "$tmp"
          else
              chmod 644 "$tmp"
              mv "$tmp" "$ranges"
              relabel "$ranges"
              say "wrote $ranges"
          fi
      fi

      exit 0
    `),
  );
}

/**
 * Ordered before the two units whose behaviour it decides: nftables loads the
 * ranges it writes, and sshd admits the group it puts the account it creates in.
 *
 * `After=local-fs.target` is what puts it after the ESP is mounted. The install
 * writes a `boot-efi.mount` naming the ESP by filesystem UUID, and a mount unit
 * with default dependencies is ordered `Before=local-fs.target` — so the ESP is
 * mounted by the time this unit's job can run, on any device node and without
 * this image knowing one.
 *
 * **The unit carries no `Condition` on a path under `/boot/efi`, and must not
 * grow one.** The ESP is FAT, so every inode on it is `dosfs_t`, and the
 * condition would be evaluated by PID 1 in `init_t`, which the targeted policy
 * does not let read that type. The check belongs in the script, which runs in a
 * domain that may: a card with no `keel.conf` gets one log line and `exit 0`,
 * leaving the unit successful rather than failed, so greenboot does not roll back
 * an image nobody has given an identity to yet.
 *
 * `SELinuxContext` for the same reason the flight recorder has one — reading the
 * ESP is not something `init_t` is allowed to do.
 */
function unit(): Tree {
  return file(
    "/usr/lib/systemd/system/keel-firstboot.service",
    dedent(`
      [Unit]
      Description=Apply the identity from keel.conf on the ESP
      After=local-fs.target
      Wants=network-pre.target
      Before=network-pre.target nftables.service sshd.service

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      SELinuxContext=system_u:system_r:unconfined_t:s0
      ExecStart=${FIRSTBOOT_PATH}

      [Install]
      WantedBy=multi-user.target
    `),
  );
}

export function renderFirstboot(): Tree {
  return merge(firstboot(), unit());
}
