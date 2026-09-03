import { dedent, file, merge, symlink, type Tree } from "./tree";

/**
 * Dangling layers accumulate in /var, which on a bootc system is the one place
 * that is never reset by an image update — so nothing else will ever clean it.
 *
 * `image prune` without `--all`: it removes untagged layers only, so a bound
 * image, or any image a quadlet references, is untouched. `--all` would delete
 * the app images out from under running services on the next restart.
 */
function pruneTimer(): Tree {
  return merge(
    file(
      "/usr/lib/systemd/system/keel-podman-prune.service",
      dedent(`
        [Unit]
        Description=Reclaim dangling container layers
        ConditionPathExists=/usr/bin/podman

        [Service]
        Type=oneshot
        ExecStart=/usr/bin/podman image prune --force
        Nice=10
        IOSchedulingClass=idle
      `),
    ),
    file(
      "/usr/lib/systemd/system/keel-podman-prune.timer",
      dedent(`
        [Unit]
        Description=Reclaim dangling container layers weekly
        # Persistent, so it has to wait for the clock: a board with no RTC boots
        # at the image's build date, and a persistent timer that loads before
        # NTP steps the clock forward fires as if it had missed every window in
        # the jump. chrony-wait holds time-sync.target until synchronised.
        After=time-sync.target

        [Timer]
        OnCalendar=Sun 04:00
        # Boards are off often enough that a missed window would otherwise mean
        # the prune simply never runs.
        Persistent=true
        RandomizedDelaySec=30m

        [Install]
        WantedBy=timers.target
      `),
    ),
  );
}

/**
 * podman-auto-update is masked rather than merely left disabled, and that is a
 * deliberate contradiction of how the old repo worked.
 *
 * Every image reference here is pinned, and Pulumi decides what runs. An updater
 * that pulls a newer tag on a timer would move a service without anything having
 * declared the move — no diff, no review, no rollback point. The way to update a
 * service in keel is to change its pin and let the change be visible.
 *
 * podman.socket is deliberately *not* enabled either: nothing here speaks the
 * Docker API, since Traefik reads route files rather than container labels, and
 * that socket is root-equivalent to whoever can reach it.
 */
function noAutoUpdate(): Tree {
  return merge(
    symlink("/etc/systemd/system/podman-auto-update.timer", "/dev/null"),
    symlink("/etc/systemd/system/podman-auto-update.service", "/dev/null"),
  );
}

/**
 * Podman's graph root. Present as a tmpfiles entry rather than shipped content:
 * anything under /var in the image is seeded once and never updated again, so a
 * directory that is meant to hold live state has to be created at boot.
 */
function storage(): Tree {
  return file(
    "/usr/lib/tmpfiles.d/keel-containers.conf",
    dedent(`
      d /var/lib/containers 0700 root root - -
    `),
  );
}

/**
 * What podman needs to be a container host: a graph root, a prune timer, and
 * nothing that can move a service on its own.
 */
export function renderContainers(): Tree {
  return merge(pruneTimer(), noAutoUpdate(), storage());
}
