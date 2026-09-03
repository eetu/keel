import { ADMIN_GROUP, JOURNAL_MAX_USE, MODPROBE_DENY } from "../config/keel";
import { MASKED_UNITS } from "../config/versions";
import { dedent, file, merge, symlink, type Tree } from "./tree";

/**
 * Masking, not disabling: a masked unit cannot be started even as another unit's
 * dependency, and everything in this list is something the base image enables
 * and something else would otherwise pull in.
 */
function maskedUnits(): Tree {
  return merge(...MASKED_UNITS.map((unit) => symlink(`/etc/systemd/system/${unit}`, "/dev/null")));
}

/**
 * sshd is configured by replacing `/etc/ssh/sshd_config` outright rather than
 * dropping a file into `sshd_config.d`. Two reasons: the image should own the
 * whole policy with no distro defaults leaking in, and `Match` blocks must be
 * last in the effective config — the distro's `Include` sits at the *top* of
 * sshd_config, so a `Match` in a drop-in would swallow every directive after it.
 *
 * Nothing jails failed attempts beside it, and that is the safer position on a
 * headless board. Password authentication is off, so there is no brute force to
 * slow down and an ed25519 key is not guessable; the packet filter admits SSH
 * only from the address sets a host is given, so every address a jail could ban
 * has already been admitted deliberately. What a jail does reliably do is lock
 * out legitimate access — an agent offering several keys against `MaxAuthTries 3`
 * earns an hour's ban from the machine whose recovery path is that same SSH.
 */
function sshd(): Tree {
  return file(
    "/etc/ssh/sshd_config",
    dedent(`
      Port 22
      Protocol 2

      # Replacing the whole file drops the distro's own defaults, and on Fedora
      # this one is not optional: the build refuses 'UsePAM no' outright
      # ("not supported in this build and may cause several problems"). Without
      # PAM there is no pam_systemd session, no pam_limits, and account state is
      # evaluated by sshd's own shadow handling instead.
      UsePAM yes

      PermitRootLogin no
      PasswordAuthentication no
      PubkeyAuthentication yes
      AuthorizedKeysFile .ssh/authorized_keys

      # A group, so the image names no account. Which login is admitted is then a
      # property of the machine rather than of the artefact: whoever
      # keel-firstboot put in this group is who gets in, and an image shared with
      # a stranger carries no login of anyone else's. It is also what makes
      # changing the account safe — an existing member keeps working across a
      # rename, so there is no boot on which nobody can reach the board.
      AllowGroups ${ADMIN_GROUP}

      MaxAuthTries 3
      # A deploy is one ssh connection per resource, in parallel; the default
      # 10:30:100 resets the overflow mid-handshake and a refresh dies on
      # "kex_exchange_identification". Multiplexing on the client is the first
      # line of defense; this is the second, for the client that forgot.
      MaxStartups 40:30:100
      # The other throttle, for the client that multiplexes: every session then
      # rides one connection, and the default 10 refuses the rest with "Session
      # open refused by peer" — which a deploy's sixty parallel reads hit at once.
      MaxSessions 100
      LoginGraceTime 30
      ClientAliveInterval 300
      ClientAliveCountMax 2
      UseDNS no
      AllowTcpForwarding no
      PermitTunnel no

      X11Forwarding no
      PrintMotd no
      AcceptEnv LANG LC_*
      Subsystem sftp /usr/libexec/openssh/sftp-server

      # Scoped exception to the global no above: an admin may TCP-forward, so
      # local development can tunnel to loopback-only services. That key already
      # grants shell and sudo, so the marginal risk is nil. Matched on the same
      # group as the grant above, which is the whole set of accounts that can
      # authenticate anyway.
      # Everything below this line is conditional — keep Match blocks last.
      Match Group ${ADMIN_GROUP}
          AllowTcpForwarding yes
    `),
  );
}

function journald(): Tree {
  return file(
    "/usr/lib/systemd/journald.conf.d/99-keel.conf",
    dedent(`
      [Journal]
      Storage=volatile
      RuntimeMaxUse=${JOURNAL_MAX_USE}
    `),
  );
}

/**
 * The kernel version is fixed by the image, so this needs no runtime probe: a
 * denied module is denied for as long as this image is booted, and the decision
 * is reviewable in the same diff as everything else.
 */
function modprobeDeny(): Tree {
  const lines = MODPROBE_DENY.flatMap((mod) => [`blacklist ${mod}`, `install ${mod} /bin/false`]);
  return file("/usr/lib/modprobe.d/keel-deny.conf", `${lines.join("\n")}\n`);
}

/**
 * Passwordless sudo, which the deploy model requires rather than merely finds
 * convenient: every device resource reaches the host as `ssh <alias> sudo …`, so
 * without this the whole Pulumi layer fails on a real machine. The old repo
 * needed the same grant for the same reason.
 *
 * Granted to the group sshd admits, so the two cannot fall out of step: an
 * account that can log in can deploy, and an account outside the group has
 * neither. It widens nothing an ssh key does not already grant — that key is the
 * only way in and sshd refuses passwords and root.
 *
 * Mode 0440: sudo refuses to read a group- or world-writable drop-in, and
 * ignores one whose name contains a dot or ends in `~`.
 */
function sudoers(): Tree {
  return file("/etc/sudoers.d/keel-admin", `%${ADMIN_GROUP} ALL=(ALL) NOPASSWD:ALL\n`, 0o440);
}

/**
 * Directories the image needs at runtime. `/etc/secrets` is 0700 and holds the
 * age-decrypted env files.
 *
 * A service's own `/var/lib` state is made by its own quadlet, which mkdirs the
 * one directory it mounts before it starts — so retiring a service cannot leave
 * an orphaned entry here, and no directory here names a service. What belongs
 * is state a *package* ships: content in `/var` is seeded from the first image
 * and never updated again, so a directory without a tmpfiles entry can never be
 * recreated. `bootc container lint` fails the build on a missing one and prints
 * the line to add.
 */
function tmpfiles(): Tree {
  return file(
    "/usr/lib/tmpfiles.d/keel.conf",
    dedent(`
      d /etc/secrets 0700 root root - -
      d /var/lib/keel 0755 root root - -
    `),
  );
}

/**
 * Mount the root filesystem `noatime`.
 *
 * Without it, every read updates an inode's access time — a metadata write for
 * a card whose whole point is minimizing writes, on a filesystem journaled by
 * ext4 to begin with. Nothing here reads atime: no mail spool, no mtime-vs-atime
 * cache eviction, nothing that depends on it.
 *
 * `rootflags=` is how bootc composes options for the root mount specifically —
 * an `/etc/fstab` entry for `/` does not exist to be edited, since bootc/ostree
 * assembles that mount itself. `kargs.d` is the mechanism because it is image
 * content: a TOML file under `/usr/lib/bootc/kargs.d`, read at every deployment
 * rather than baked in once at install, so it updates the same way the rest of
 * the image does.
 *
 * Unverified: whether bootc-image-builder's own install-time kargs handling
 * carries this through onto the disk it writes, as opposed to only a `bootc
 * upgrade` on an already-installed system. `image/qemu-test.sh` checks
 * `findmnt -no OPTIONS /sysroot` for `noatime` on a card built that way, but
 * that check has not yet run against a built image.
 */
function kargs(): Tree {
  return file(
    "/usr/lib/bootc/kargs.d/50-keel.toml",
    dedent(`
      # quiet: the kernel and the initrd otherwise narrate the whole boot down the
      # serial console at 115200 baud, which on a Pi 4 is most of a minute before
      # userspace starts. Warnings still reach the console, everything still
      # reaches dmesg and the journal, which is where the flight recorder reads.
      kargs = ["rootflags=noatime", "quiet"]
    `),
  );
}

/**
 * chronyd starts by setting the clock to the drift file's timestamp.
 *
 * A Pi has no real-time clock, so without this the kernel boots believing it
 * is whenever the image was built, and stays there until the first NTP answer
 * — long enough for anything that validates a certificate before then, an
 * image pull included, to be looking at a clock weeks in the past. chrony
 * rewrites its drift file while it runs, so the file's timestamp is the last
 * time the board knew what time it was; `-s` moves the clock there first, and
 * NTP then corrects minutes rather than weeks. `-F 2` is Fedora's own default,
 * the seccomp filter, kept rather than dropped by overriding the file.
 */
function chronyOptions(): Tree {
  return file(
    "/etc/sysconfig/chronyd",
    dedent(`
      OPTIONS="-F 2 -s"
    `),
  );
}

/**
 * Grow the root partition and filesystem to fill whatever medium the image was
 * written to.
 *
 * A built disk image is a fixed size — 10 GB as bootc-image-builder lays it out —
 * so flashing it to a 16 or 32 GB card otherwise leaves the remainder
 * unallocated. Two operations are needed and they are distinct: moving the
 * partition's end, then the filesystem's.
 *
 * Idempotent, so it runs on every boot with no stamp file: once there is nothing
 * left to claim both steps are no-ops, which also means a card later cloned onto
 * a larger one is picked up for free.
 */
function growfs(): Tree {
  return file(
    "/usr/lib/systemd/system/keel-growfs.service",
    dedent(`
      [Unit]
      Description=Grow the root filesystem to fill its disk (bare metal included)
      # Upstream ships both the implementation and the right conditions for a VM,
      # but its unit carries ConditionVirtualization=vm and says so in a comment:
      # "For now we skip bare metal cases". Bare metal is the only target this
      # fleet has, so the policy of when to run needs replacing while the logic
      # does not — that logic already handles the part which is easy to get wrong,
      # where the real filesystem is /sysroot rather than the composefs mounted at
      # /, and has to be remounted writable before it can be resized.
      ConditionVirtualization=!container
      ConditionPathIsMountPoint=/sysroot
      ConditionPathExists=/usr/libexec/bootc-generic-growpart
      # Ahead of anything that pulls a container image onto the disk we are about
      # to enlarge.
      DefaultDependencies=no
      Requires=sysinit.target
      After=sysinit.target
      Before=basic.target

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      ExecStart=/usr/libexec/bootc-generic-growpart
      # So the temporary writable remount of /sysroot does not leak out.
      MountFlags=slave
      PrivateTmp=yes

      [Install]
      WantedBy=multi-user.target
    `),
  );
}

/**
 * Units enabled at image build. A preset file is the image-native way to say
 * "enabled by default" — the Containerfile runs `systemctl preset-all`, which
 * writes the symlinks, so no `systemctl enable` litters the build.
 */
export function renderPresets(units: readonly string[]): Tree {
  const lines = units.map((unit) => `enable ${unit}`);
  return file("/usr/lib/systemd/system-preset/50-keel.preset", `${lines.join("\n")}\n`);
}

/** Hardening and host policy, on every board: no services, nothing local. */
export function renderBase(): Tree {
  return merge(
    sshd(),
    journald(),
    modprobeDeny(),
    tmpfiles(),
    maskedUnits(),
    kargs(),
    chronyOptions(),
    growfs(),
    sudoers(),
  );
}
