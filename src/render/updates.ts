import { dedent, file, merge, type Tree } from "./tree";

/**
 * A drop-in on the timer bootc itself ships, not a unit this image owns —
 * `bootc-fetch-apply-updates.timer` already exists in the base image, enabled by
 * default.
 *
 * The upstream defaults (`OnBootSec=1h`, `OnUnitInactiveSec=8h`) poll for a new
 * image every few hours, which is the right default for a fleet with no opinion
 * and the wrong one here: a board on the LAN's own DNS wants its outage on a
 * schedule someone chose, not whenever the timer happens to fire. Blanking both
 * keys and setting `OnCalendar=` replaces polling with one weekly window —
 * Saturday pre-dawn, when a resolver restart costs nobody a lookup.
 *
 * `FixedRandomDelay=true` hashes the machine's own ID into the random delay
 * instead of drawing a new one on every timer activation, so a host's offset
 * inside the four-hour spread is stable rather than reshuffled each week — the
 * property that keeps the fleet from ever converging on the same minute.
 *
 * `Persistent=true` covers a board that is off at 05:00: the timer fires once on
 * the next boot instead of waiting a full week for the window to come back
 * around.
 *
 * After a greenboot rollback, this timer is still the thing that runs next
 * Saturday — it re-stages the same digest that just got rolled back, because
 * nothing here or in greenboot marks a digest bad. The fix for a bad image is
 * publishing a fixed one before the next window, not disabling the timer.
 */
/**
 * A disk built by bootc-image-builder tracks the ref it was built from —
 * `localhost/keel:latest` — until `bootc switch` points it at the real
 * registry. On such a card `bootc upgrade` dials https://localhost/v2/ and
 * fails, and a unit failing on every fresh card marks every boot bad to the
 * flight recorder, which then writes the full journal to the ESP each time.
 *
 * `ExecCondition` exits 1 when the booted origin is still localhost, which
 * systemd records as a skipped condition rather than a failure: a card nobody
 * has switched yet has nothing to update from, and that is a state, not an
 * error. The exit codes matter — 1 through 254 skip, 255 fails — so the grep's
 * result is the whole mechanism.
 */
function serviceGate(): Tree {
  return file(
    "/usr/lib/systemd/system/bootc-fetch-apply-updates.service.d/50-keel.conf",
    dedent(`
      [Service]
      ExecCondition=/bin/sh -c "! bootc status --format=yaml | grep -q 'image: localhost/'"
    `),
  );
}

function timerWindow(): Tree {
  return file(
    "/usr/lib/systemd/system/bootc-fetch-apply-updates.timer.d/50-keel.conf",
    dedent(`
      [Unit]
      # Persistent, so it waits for a synchronised clock like every persistent
      # timer here: a board with no RTC would otherwise treat NTP's first step
      # as weeks of missed windows and fetch an update on every boot.
      After=time-sync.target

      [Timer]
      OnBootSec=
      OnUnitInactiveSec=
      OnCalendar=Sat *-*-* 05:00
      RandomizedDelaySec=4h
      FixedRandomDelay=true
      Persistent=true
    `),
  );
}

export function renderUpdates(): Tree {
  return merge(timerWindow(), serviceGate());
}
