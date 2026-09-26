import { dedent, file, merge, script, symlink, type Tree } from "./tree";

/**
 * Images accumulate in /var, which on a bootc system is the one place that is
 * never reset by an image update — so nothing else will ever clean it.
 *
 * `podman image prune` is what this used to be, and on this fleet it reclaims
 * nothing: it removes dangling images, and keel has none by construction. An
 * entry's image is resolved to a digest and pulled by it, so a superseded image
 * keeps a RepoDigest and is never dangling. A board measured 48 images, 3.0 GB,
 * a third of it unreferenced, and zero dangling layers to find.
 *
 * `--all` is the other extreme, and wrong for a different reason: it keeps only
 * what a container refers to, and a scheduled entry has no container between
 * runs. Its image would be pruned and pulled again at the next window, over a
 * home uplink, inside a start job.
 *
 * So the keep set is both, which is what the script computes.
 */
function pruneScript(): Tree {
  return script(
    "/usr/lib/keel/prune-images",
    dedent(`
      #!/usr/bin/bash
      # Reclaim container images this board no longer needs: everything outside
      # the set a container refers to, running or not, plus everything a quadlet
      # names.
      set -euo pipefail

      resolve() {
          while read -r ref; do
              [ -n "$ref" ] || continue
              podman image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true
          done
      }

      # A board with no quadlets matches no glob, and awk handed the literal
      # pattern exits 2 — which pipefail makes the run's failure.
      shopt -s nullglob
      quadlets=(/etc/containers/systemd/*.container)

      # Held in a variable, not a mktemp file. systemd execs this lib_t script
      # with no domain transition, so bash runs as init_t while mktemp, a bin_t
      # binary, transitions and labels its file tmp_t — which init_t may not
      # append to.
      keep=$(
          podman ps --all --format '{{.Image}}' | resolve
          if [ \${#quadlets[@]} -gt 0 ]; then
              awk -F= '/^Image=/ { print $2 }' "\${quadlets[@]}" | resolve
          fi
      )

      # Removal is by name, and by id only for an image that has none. Never
      # \`rmi --force\`: that deletes the containers using an image too, so a
      # container created between the listing and the removal would go with it.
      podman images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' |
          while read -r id ref; do
              # \`podman images\` prints an algorithm prefix and \`image inspect\`
              # does not, so an unnormalised comparison matches nothing — and a
              # keep set that matches nothing removes the whole store.
              case $'\\n'"$keep"$'\\n' in *$'\\n'"\${id#sha256:}"$'\\n'*) continue ;; esac
              case "$ref" in
              *:'<none>' | '<none>:<none>') podman rmi "$id" || true ;;
              *) podman rmi "$ref" || true ;;
              esac
          done
    `),
  );
}

function pruneTimer(): Tree {
  return merge(
    pruneScript(),
    file(
      "/usr/lib/systemd/system/keel-podman-prune.service",
      dedent(`
        [Unit]
        Description=Reclaim unreferenced container images
        ConditionPathExists=/usr/bin/podman

        [Service]
        Type=oneshot
        ExecStart=/usr/lib/keel/prune-images
        Nice=10
        IOSchedulingClass=idle
      `),
    ),
    file(
      "/usr/lib/systemd/system/keel-podman-prune.timer",
      dedent(`
        [Unit]
        Description=Reclaim unreferenced container images weekly
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
