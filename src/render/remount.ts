/**
 * A network mount that failed is retried, and what needed it is started.
 *
 * systemd has `Restart=` for a service and nothing of the kind for a mount: a
 * share whose server is off when the board boots — a power cut the Pi recovers
 * from faster than the NAS does — fails once and stays failed. Every quadlet
 * that binds a path under it carries `RequiresMountsFor=`, which is `Requires=`
 * on the mount unit, so those services end their start job with "Dependency
 * failed" and never ran: `Restart=always` applies to a service that ran and
 * died, not to one whose dependency did, and they sit inactive until a person
 * deploys or reboots.
 *
 * An automount is the tempting fix and does nothing here. `RequiresMountsFor=`
 * resolves to the `.mount` unit and never to an `.automount`
 * (`unit_add_mount_dependencies` in systemd's `src/core/unit.c`), so a service's
 * start still pulls the mount job and still fails on it; the trigger would serve
 * a shell walking into the directory, not a container.
 *
 * So the image polls, the way it polls for failures and for a share's address:
 * every five minutes `keel-remount.service` starts every failed mount whose
 * source is a network path, and for each that comes up starts the units that
 * `Requires=` it. A start on an active unit is a no-op, so a tick with nothing
 * failed touches nothing, and a retired service is disabled by the deploy and
 * so never in a mount's `RequiredBy=`.
 *
 * The other way a share dies is quieter: its server moves address, the kernel's
 * session is to the old one, and the mount stays *active* while every access
 * answers "Host is down". `keel-hosts` learns the new address within minutes,
 * but a mount only reads the name when it mounts. So the same tick also asks
 * each active network mount to answer a `statfs` within ten seconds, and
 * restarts the one that cannot — which remounts against the current address
 * and, through `Requires=`, restarts the services that bind it.
 */

import { dedent, file, merge, script, type Tree } from "./tree";

export const REMOUNT_SCRIPT_PATH = "/usr/lib/keel/remount";
export const KEEL_REMOUNT_SERVICE = "keel-remount.service";
export const KEEL_REMOUNT_TIMER = "keel-remount.timer";

function remountScript(): Tree {
  return script(
    REMOUNT_SCRIPT_PATH,
    dedent(`
      #!/bin/sh
      # Retry every failed network mount, then start what requires each one
      # that came up; restart every active network mount whose server no longer
      # answers. Exits 0 always: a share that is still down is the mount unit's
      # own failed state, already reported, and not this unit's. Every unit
      # name follows a "--": the root mount is "-.mount", which systemctl
      # would otherwise read as an option.
      set -u

      systemctl list-units --type=mount --state=failed,active --plain --no-legend |
        while read -r unit _ active _; do
          case "$(systemctl show -p What --value -- "$unit")" in
            //*) ;;
            *) continue ;;
          esac
          if [ "$active" = active ]; then
            where="$(systemctl show -p Where --value -- "$unit")"
            if ! timeout 10 stat -f "$where" >/dev/null 2>&1; then
              echo "keel-remount: $unit is stale, restarting"
              systemctl restart -- "$unit" || true
            fi
            continue
          fi
          if systemctl start -- "$unit"; then
            echo "keel-remount: $unit mounted"
            for dependent in $(systemctl show -p RequiredBy --value -- "$unit"); do
              systemctl start -- "$dependent" && echo "keel-remount: $dependent started"
            done
          fi
        done
      exit 0
    `),
  );
}

function serviceUnit(): Tree {
  return file(
    `/usr/lib/systemd/system/${KEEL_REMOUNT_SERVICE}`,
    dedent(`
      [Unit]
      Description=Retry failed network mounts and start what requires them
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=oneshot
      ExecStart=${REMOUNT_SCRIPT_PATH}
    `),
  );
}

/**
 * Two minutes after boot — the mounts' own attempt has been decided by then,
 * and a NAS that was a minute behind the board is up — and every five minutes
 * after that. Not `Persistent`: a missed tick has nothing to catch up on.
 */
function timerUnit(): Tree {
  return file(
    `/usr/lib/systemd/system/${KEEL_REMOUNT_TIMER}`,
    dedent(`
      [Unit]
      Description=Retry failed network mounts every five minutes

      [Timer]
      OnBootSec=2min
      OnUnitActiveSec=5min

      [Install]
      WantedBy=timers.target
    `),
  );
}

export function renderRemount(): Tree {
  return merge(remountScript(), serviceUnit(), timerUnit());
}
