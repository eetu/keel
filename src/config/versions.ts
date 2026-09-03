/**
 * What `/usr/lib/keel/selftest` checks the image against at every boot: the
 * binaries that must be on PATH, the units whose failure is a failed boot, and
 * the units masked outright so nothing can start them.
 */

/**
 * Must be on PATH or the image is broken in a way that is silent until it
 * matters: without `age` no secret is ever decrypted, and every service starts
 * with an empty environment. `semanage` is what labels unbound's port —
 * without it the resolver cannot bind under enforcing SELinux.
 */
export const REQUIRED_BINARIES: readonly string[] = [
  "age",
  "growpart",
  "nft",
  "podman",
  "semanage",
  "sshd",
];

/**
 * Units that must be active for the host to be doing its job. A failure here is
 * a failed boot: greenboot retries, then rolls back to the previous image.
 *
 * Keep this list precise. Anything added here becomes a rollback trigger, and a
 * flaky service in the list turns a working image into three reboots and a
 * rollback. Broader observations belong in the advisory checks instead.
 */
export const REQUIRED_UNITS: readonly string[] = [
  "sshd.service",
  "nftables.service",
  "unbound.service",
];

/**
 * Units symlinked to `/dev/null`, which stops them starting even as another
 * unit's dependency — `disable` alone does not.
 */
export const MASKED_UNITS: readonly string[] = [
  // This host *is* the resolver: Pi-hole answers :53 and Unbound :5335. Fedora
  // enables systemd-resolved by default, which would contend for :53 and take
  // over resolv.conf — the same reason the netbird agent runs with
  // `--disable-dns`.
  "systemd-resolved.service",
  // Its socket is enabled separately and fails every boot with `Failed to
  // listen on systemd-resolved-varlink.socket` once the service is masked — a
  // failed unit on a healthy boot, which is noise in the one place the selftest
  // and the flight recorder look for trouble.
  "systemd-resolved-varlink.socket",
  // `/etc/udev/hwdb.bin` is image content, built when systemd-udev was
  // installed into the image; the unit would rebuild the identical file on
  // every boot after an image update, twelve seconds on a Pi 4, ahead of
  // `sysinit.target` where everything waits on it.
  "systemd-hwdb-update.service",
  // Desktop disk management, wanted by `graphical.target` and required by no
  // package here. It starts D-Bus-activated polkit alongside it, and the pair
  // costs twenty seconds of CPU during the boot's busiest minute for nothing
  // a headless board ever asks of them.
  "udisks2.service",
];
