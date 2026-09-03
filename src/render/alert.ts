/**
 * Failure alerts, from the image, into whichever service claims the alert sink.
 *
 * A failed unit on this board used to be discovered by somebody looking: the
 * nightly backup can die at four in the morning and stay dead until a person
 * runs `systemctl --failed`. So the image polls. Every five minutes
 * `keel-alert.service` lists the units that are failed or stuck restarting,
 * posts each new one once — with the unit's own journal tail, which is the
 * message a person would otherwise ssh in to read — and posts once more when it
 * recovers. What it posts to is `/etc/keel/alert.conf`, written by the deploy
 * layer from the catalog entry that declares the `alerts` role; a board with no
 * such entry has an empty file and the poll says nothing.
 *
 * Polling rather than `OnFailure=`, and that is the decision this file rests on.
 * A quadlet carries `Restart=always`, and a container that crashes on every
 * start never enters the failed state: systemd keeps it in `activating
 * (auto-restart)`, and an `OnFailure=` hook never fires. The poll sees that
 * state directly. A hook would also have to be a line in every unit body, and a
 * changed body is a restart of every service on the board for no change in
 * behaviour — while a global `service.d` drop-in would fire on podman's own
 * transient health-check units, which fail by design when a check does.
 *
 * The state — which units have been reported — lives under `/var/lib/keel`,
 * which systemd creates through `StateDirectory=` so the script needs no
 * directory of its own. It survives a reboot on purpose: a unit that fails at
 * every boot is one alert, not one per boot.
 */

import { dedent, file, merge, script, type Tree } from "./tree";

/** Read by the script; written by the deploy layer as `KEY=VALUE` lines. */
export const ALERT_CONFIG_PATH = "/etc/keel/alert.conf";

export const ALERT_SCRIPT_PATH = "/usr/lib/keel/alert";
export const KEEL_ALERT_SERVICE = "keel-alert.service";
export const KEEL_ALERT_TIMER = "keel-alert.timer";

/**
 * The deploy layer's file: the URL a message is POSTed to, or nothing. Written
 * even when there is no sink, for the same reason every other `/etc/keel` input
 * is — a present-and-empty file and an absent one have to converge alike, and
 * the script treats both as "say nothing".
 */
export function renderAlertConfig(url: string | undefined): string {
  return url === undefined
    ? "# No catalog entry claims the alerts role, so failures are not posted anywhere.\n"
    : `NTFY_URL=${url}\n`;
}

function alertScript(): Tree {
  return script(
    ALERT_SCRIPT_PATH,
    dedent(`
      #!/usr/bin/env python3
      """Post failed and crash-looping units to the alert sink, once each, and
      their recovery once more.

      The sink is NTFY_URL in ${ALERT_CONFIG_PATH}; with none configured this
      prints what it would have said and exits 0. State lives in
      $STATE_DIRECTORY (systemd's), so a unit that is still failing at the next
      tick is not reported twice, and one that fails on every boot is reported
      once. Always exits 0: the poller is never the failure it reports.
      """

      import json
      import os
      import re
      import socket
      import subprocess
      import sys
      import urllib.request

      CONFIG = "${ALERT_CONFIG_PATH}"
      STATE = os.path.join(os.environ.get("STATE_DIRECTORY", "/var/lib/keel"), "alert-state.json")
      JOURNAL_LINES = 12
      # podman runs each health check as a transient unit named after the
      # container id; one that fails is a check that failed, which the service's
      # own state already reflects.
      TRANSIENT = re.compile(r"^[0-9a-f]{64}-[0-9a-f]+\\.service$")


      def sink():
          try:
              with open(CONFIG) as handle:
                  for line in handle:
                      key, _, value = line.strip().partition("=")
                      if key == "NTFY_URL" and value:
                          return value
          except FileNotFoundError:
              pass
          return None


      def failing():
          """unit -> reason, for every unit systemd reports as failed or as
          stuck in auto-restart — the state a crash-looping container lives in
          without ever reaching 'failed'."""
          out = subprocess.run(
              ["systemctl", "list-units", "--all", "--plain", "--no-legend", "--output=json"],
              capture_output=True,
              text=True,
              check=True,
          ).stdout
          found = {}
          for unit in json.loads(out or "[]"):
              name = unit.get("unit", "")
              if TRANSIENT.match(name):
                  continue
              if unit.get("active") == "failed":
                  found[name] = "failed"
              elif unit.get("sub") == "auto-restart":
                  found[name] = "crash-looping"
          return found


      def journal(unit):
          return subprocess.run(
              ["journalctl", "-u", unit, "-n", str(JOURNAL_LINES), "--no-pager", "-o", "cat"],
              capture_output=True,
              text=True,
          ).stdout.strip()


      def post(url, title, body, priority, tags):
          request = urllib.request.Request(
              url,
              data=body.encode(),
              headers={"Title": title, "Priority": priority, "Tags": tags},
              method="POST",
          )
          try:
              with urllib.request.urlopen(request, timeout=10):
                  return True
          except OSError as error:
              print("keel-alert: could not post to the sink: " + str(error), file=sys.stderr)
              return False


      def load_state():
          try:
              with open(STATE) as handle:
                  return json.load(handle)
          except (FileNotFoundError, ValueError):
              return {}


      def save_state(state):
          tmp = STATE + ".tmp"
          with open(tmp, "w") as handle:
              json.dump(state, handle, sort_keys=True)
          os.replace(tmp, STATE)


      def main():
          host = socket.gethostname()
          url = sink()
          reported = load_state()
          current = failing()

          for unit, reason in sorted(current.items()):
              if reported.get(unit) == reason:
                  continue
              title = host + ": " + unit + " " + reason
              body = journal(unit) or "(no journal lines)"
              print("keel-alert: " + title)
              if url is None or post(url, title, body, "high", "warning"):
                  reported[unit] = reason

          for unit in sorted(set(reported) - set(current)):
              title = host + ": " + unit + " recovered"
              print("keel-alert: " + title)
              if url is None or post(url, title, "active again", "default", "white_check_mark"):
                  del reported[unit]

          save_state(reported)
          return 0


      if __name__ == "__main__":
          sys.exit(main())
    `),
  );
}

function serviceUnit(): Tree {
  return file(
    `/usr/lib/systemd/system/${KEEL_ALERT_SERVICE}`,
    dedent(`
      [Unit]
      Description=Post failed units to the alert sink
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=oneshot
      ExecStart=${ALERT_SCRIPT_PATH}
      StateDirectory=keel
    `),
  );
}

/**
 * Three minutes after boot — after the services keel deploys have had their
 * start jobs decided, so a boot is judged rather than watched — and every five
 * minutes after that. Not `Persistent`: a missed tick has nothing to catch up
 * on, the next one reads the same state.
 */
function timerUnit(): Tree {
  return file(
    `/usr/lib/systemd/system/${KEEL_ALERT_TIMER}`,
    dedent(`
      [Unit]
      Description=Poll for failed units every five minutes

      [Timer]
      OnBootSec=3min
      OnUnitActiveSec=5min

      [Install]
      WantedBy=timers.target
    `),
  );
}

export function renderAlert(): Tree {
  return merge(alertScript(), serviceUnit(), timerUnit());
}
