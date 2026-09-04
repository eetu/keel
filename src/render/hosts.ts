/**
 * NetBIOS name resolution for a share or the backup target, into `/etc/hosts`.
 *
 * `Share.host` and `BackupTarget.host` may be a name rather than an address, for
 * a node this LAN's own router never learns to answer for — this fleet's NAS
 * moved to a new DHCP-handed address without the router's resolver ever hearing
 * about it, and the router advertises no mDNS either. The one thing that answers
 * for such a node is a NetBIOS NAME QUERY broadcast to UDP 137, which is what
 * `smbutil lookup` and `nmblookup` do by hand. The board runs no name service of
 * its own, and both readers of `host` resolve through the kernel's or libc's
 * ordinary lookup — `mount.cifs` through `getaddrinfo`, the backup's own
 * `socket.getaddrinfo` the same way — which both read `/etc/hosts` before they
 * ask anything else. So the image puts the answer there itself.
 *
 * `resolve-netbios` runs at boot and every five minutes: a share is mounted once
 * and a mount that outlives an address change keeps working regardless, but the
 * backup and a share's first mount after a reboot both need a current answer,
 * and a five-minute drop-in is what lets either happen without waiting for one.
 * Every run replaces the whole managed block with whatever answered *this* time
 * — a name that stops answering drops out of `/etc/hosts` rather than pinning a
 * stale address there, so the mount or the backup that needed it fails on its
 * own, with the address missing, which is the true reason. A name that never
 * answers is therefore not this unit's failure to report: it is logged to
 * stderr and the script still exits 0.
 *
 * **No `SELinuxContext` on the service, and that is a decision and not an
 * omission.** `keel-firstboot` needs `unconfined_t` because the ESP is FAT —
 * every inode on it is `dosfs_t`, which the targeted policy denies `init_t`
 * `read` on even though `getattr` passes, so a plain unit reading it gets a card
 * that looks blank. Nothing here reads removable media: the interpreter is named
 * by the script's own shebang, ordinary image content under `/usr/lib/keel`, and
 * the file it rewrites is `/etc/hosts`, labelled `net_conf_t` — a type the
 * init domain a plain service inherits already has permission to manage, the
 * same domain that lets `dhclient` and `NetworkManager` rewrite
 * `/etc/resolv.conf`. There is no ESP-shaped exception to route around here.
 */

import { dedent, file, merge, script, type Tree } from "./tree";

/** Read by the script; written by the deploy layer, one NetBIOS name per line. */
export const HOSTS_D_DIR = "/etc/keel/hosts.d";

/** Where the deploy layer's own drop-in lands inside it. */
export const HOSTS_CONFIG_PATH = `${HOSTS_D_DIR}/50-keel.conf`;

export const RESOLVE_NETBIOS_PATH = "/usr/lib/keel/resolve-netbios";
export const KEEL_HOSTS_SERVICE = "keel-hosts.service";
export const KEEL_HOSTS_TIMER = "keel-hosts.timer";
/** What the timer runs: the same script, in a unit that does not stay active. */
export const KEEL_HOSTS_REFRESH_SERVICE = "keel-hosts-refresh.service";

/**
 * The deploy layer's own drop-in: one name per line, sorted and deduplicated so
 * an unrelated reordering of the catalog or the shares list is not a change to
 * this file.
 *
 * Written even when it names nothing, for the reason `50-services.nft` is: an
 * absent file and a present-but-empty one converge differently, and the script
 * skips a `#` line exactly as it skips a blank one, so a comment is a body with
 * nothing to resolve rather than a special case the script has to detect.
 */
export function renderHostsConfig(names: readonly string[]): string {
  const sorted = [...new Set(names)].sort();
  if (sorted.length === 0) {
    return (
      "# No name on this host needs resolving: every mounted share and the backup\n" +
      "# target, if either exists, is addressed rather than named.\n"
    );
  }
  return sorted.map((name) => `${name}\n`).join("");
}

function resolveNetbios(): Tree {
  return script(
    RESOLVE_NETBIOS_PATH,
    dedent(`
      #!/usr/bin/env python3
      """Resolve the NetBIOS names a share or the backup target were given.

      Reads every /etc/keel/hosts.d/*.conf for one NetBIOS name per line and
      answers each with a broadcast NBNS NAME QUERY REQUEST — the one thing
      that resolves a node on this network when the router's own DNS has never
      heard of it and the node advertises no mDNS, a router handing its own USB
      share a new address being the case this exists for. mount.cifs and
      getaddrinfo both resolve a name through /etc/hosts before anything else,
      and this is what keeps an answer there. A name that does not answer is
      logged and left out of the block that follows: the mount or the backup
      that needed it then fails on its own, with the address missing, which is
      the true reason. This always exits 0, so a NAS that is briefly
      unreachable is never what a failed unit reports.
      """

      import glob
      import os
      import random
      import re
      import socket
      import struct
      import sys
      import time

      HOSTS_D = "${HOSTS_D_DIR}"
      HOSTS_FILE = "/etc/hosts"
      BEGIN = "# keel-hosts begin"
      END = "# keel-hosts end"

      NBNS_PORT = 137
      ATTEMPTS = 3
      TIMEOUT = 2.0


      def read_names(directory):
          """Every name across every *.conf in directory, deduplicated and in
          the order first seen. A missing directory or no files is nothing to
          resolve."""
          names = []
          seen = set()
          for path in sorted(glob.glob(os.path.join(directory, "*.conf"))):
              with open(path) as handle:
                  for line in handle:
                      name = line.strip()
                      if not name or name.startswith("#"):
                          continue
                      if name not in seen:
                          seen.add(name)
                          names.append(name)
          return names


      def encode_name(name):
          """RFC 1002's first-level encoding: 16 raw bytes — 15 padded with
          spaces and a suffix byte for the workstation service — become 32
          ASCII characters, four bits at a time, wrapped as the single label
          an NBNS question carries."""
          raw = name.upper().encode("ascii", "replace")[:15].ljust(15, b" ") + bytes([0x20])
          encoded = bytearray()
          for byte in raw:
              encoded.append((byte >> 4) + ord("A"))
              encoded.append((byte & 0x0F) + ord("A"))
          return bytes([len(encoded)]) + bytes(encoded) + b"\\x00"


      def build_query(name, transaction_id):
          header = struct.pack(">HHHHHH", transaction_id, 0x0110, 1, 0, 0, 0)
          question = encode_name(name) + struct.pack(">HH", 0x0020, 0x0001)
          return header + question


      def parse_response(data, transaction_id):
          """The first IPv4 out of a NAME QUERY RESPONSE that answers this
          query, or None. Header, the 34-byte answer name echoed back,
          TYPE/CLASS/TTL/RDLENGTH, then RDATA as 6-byte NB_FLAGS+address
          entries — the first one is enough to mount with."""
          if len(data) < 12:
              return None
          resp_id, flags = struct.unpack(">HH", data[:4])
          if resp_id != transaction_id or not (flags & 0x8000) or (flags & 0x000F) != 0:
              return None
          offset = 12 + 34
          if len(data) < offset + 10:
              return None
          _type, _cls, _ttl, rdlength = struct.unpack(">HHIH", data[offset : offset + 10])
          offset += 10
          if rdlength < 6 or len(data) < offset + 6:
              return None
          return socket.inet_ntoa(data[offset + 2 : offset + 6])


      def resolve(name):
          """Broadcast up to ATTEMPTS times, TIMEOUT seconds each, and return
          the first address a matching response carries — or None."""
          transaction_id = random.randint(0, 0xFFFF)
          query = build_query(name, transaction_id)
          sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
          sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
          try:
              for _ in range(ATTEMPTS):
                  try:
                      sock.sendto(query, ("255.255.255.255", NBNS_PORT))
                  except OSError as error:
                      print("keel-hosts: could not query " + name + ": " + str(error), file=sys.stderr)
                      continue
                  deadline = time.monotonic() + TIMEOUT
                  while True:
                      remaining = deadline - time.monotonic()
                      if remaining <= 0:
                          break
                      sock.settimeout(remaining)
                      try:
                          data, _ = sock.recvfrom(576)
                      except (socket.timeout, OSError):
                          break
                      address = parse_response(data, transaction_id)
                      if address is not None:
                          return address
          finally:
              sock.close()
          return None


      def render_block(resolved):
          lines = [BEGIN]
          for name in sorted(resolved):
              lines.append(resolved[name] + " " + name)
          lines.append(END)
          return "\\n".join(lines) + "\\n"


      def write_hosts(block):
          """Replace the managed block, or append one if /etc/hosts carries
          none yet. Written only when the result differs, so a steady run
          touches nothing."""
          try:
              with open(HOSTS_FILE) as handle:
                  current = handle.read()
          except FileNotFoundError:
              current = ""
          pattern = re.compile(re.escape(BEGIN) + ".*?" + re.escape(END) + "\\n?", re.DOTALL)
          if pattern.search(current):
              updated = pattern.sub(lambda _match: block, current)
          else:
              updated = current + ("" if current == "" or current.endswith("\\n") else "\\n") + block
          if updated == current:
              return False
          with open(HOSTS_FILE, "w") as handle:
              handle.write(updated)
          return True


      def main():
          names = read_names(HOSTS_D)
          if not names:
              print("keel-hosts: no names in " + HOSTS_D)
              return 0
          resolved = {}
          for name in names:
              address = resolve(name)
              if address is None:
                  print("keel-hosts: " + name + " did not answer an NBNS query", file=sys.stderr)
                  continue
              resolved[name] = address
              print("keel-hosts: " + name + " -> " + address)
          if write_hosts(render_block(resolved)):
              print("keel-hosts: updated " + HOSTS_FILE)
          return 0


      if __name__ == "__main__":
          sys.exit(main())
    `),
  );
}

/**
 * `Before=remote-fs-pre.target`, the same hook a unit that has to run ahead of
 * network mounts uses generically: a name is in `/etc/hosts` before anything
 * pulls `remote-fs.target` in, and `mountUnit` orders each share's own unit
 * after this one as well, for the boot where both start close together.
 *
 * `ExecReload` runs the same program, and it is how the deploy layer re-resolves
 * after writing a new name list: the unit ran at boot and stays active
 * (`RemainAfterExit`), so `systemctl start` on it does nothing, and a name that
 * arrived after boot would sit unresolved until the timer's next tick while the
 * mounts written beside it failed to find it. A reload re-runs it now.
 */
function serviceUnit(): Tree {
  return file(
    `/usr/lib/systemd/system/${KEEL_HOSTS_SERVICE}`,
    dedent(`
      [Unit]
      Description=Resolve NetBIOS names of the shares into /etc/hosts
      After=network-online.target
      Wants=network-online.target
      Before=remote-fs-pre.target

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      ExecStart=${RESOLVE_NETBIOS_PATH}
      ExecReload=${RESOLVE_NETBIOS_PATH}

      [Install]
      WantedBy=multi-user.target
    `),
  );
}

/**
 * The unit the timer fires. Not `keel-hosts.service` itself: that one stays
 * active after it ran (`RemainAfterExit=`, so the mounts can order after it and
 * the deploy can reload it), and a timer's start job on an active unit is a
 * no-op — worse, `OnUnitActiveSec=` counts from the unit's last activation,
 * which for a unit that never deactivates is the boot, so the timer fired once
 * and never again. A share's server that moved back to its old address then
 * went unnoticed for hours, until the status page's check on it went red. This
 * unit runs the same script and ends, so every tick is a real run.
 */
function refreshUnit(): Tree {
  return file(
    `/usr/lib/systemd/system/${KEEL_HOSTS_REFRESH_SERVICE}`,
    dedent(`
      [Unit]
      Description=Re-resolve NetBIOS names of the shares into /etc/hosts
      After=network-online.target

      [Service]
      Type=oneshot
      ExecStart=${RESOLVE_NETBIOS_PATH}
    `),
  );
}

/**
 * No `Persistent=`, unlike the backup's timers: a boot a board missed is not a
 * resolution it owes anyone, because `OnBootSec=` already runs one a couple of
 * minutes into every boot that does happen — this timer exists to keep
 * `/etc/hosts` current while the board stays up, not to catch up on downtime.
 */
function timerUnit(): Tree {
  return file(
    `/usr/lib/systemd/system/${KEEL_HOSTS_TIMER}`,
    dedent(`
      [Unit]
      Description=Re-resolve NetBIOS names as a router's node moves address

      [Timer]
      OnBootSec=2min
      OnUnitActiveSec=5min
      Unit=${KEEL_HOSTS_REFRESH_SERVICE}

      [Install]
      WantedBy=timers.target
    `),
  );
}

export function renderHosts(): Tree {
  return merge(resolveNetbios(), serviceUnit(), refreshUnit(), timerUnit());
}
