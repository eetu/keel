/**
 * Failure alerts, from the image, to wherever the installation says.
 *
 * A failed unit on this board used to be discovered by somebody looking: the
 * nightly backup can die at four in the morning and stay dead until a person
 * runs `systemctl --failed`. So the image polls. Every five minutes
 * `keel-alert.service` lists the units that are failed or stuck restarting,
 * posts each new one once — with the unit's own journal tail, which is the
 * message a person would otherwise ssh in to read — and posts once more when it
 * recovers. What it posts to is `/etc/keel/alert.conf`, written by the deploy
 * layer from `INSTALLATION.alerts`; a board whose installation names no sink has
 * an empty file and the poll says nothing.
 *
 * The sink is deliberately not a service on this board. One that is cannot
 * report the failure that matters most — this fleet's board fell off the network
 * and took its own notifier with it, so the alert nobody received was the only
 * one worth sending. An off-board address survives the host it watches.
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

import { type AlertSink } from "../config/types";
import { dedent, file, merge, script, type Tree } from "./tree";

/** Read by the script; written by the deploy layer as `KEY=VALUE` lines. */
export const ALERT_CONFIG_PATH = "/etc/keel/alert.conf";

export const ALERT_SCRIPT_PATH = "/usr/lib/keel/alert";
export const KEEL_ALERT_SERVICE = "keel-alert.service";
export const KEEL_ALERT_TIMER = "keel-alert.timer";

/**
 * When a stalling board is worth a phone alert.
 *
 * PSI's `some avg300` is the share of the last five minutes in which at least
 * one task was stalled waiting for that resource. The thresholds are set against
 * this fleet's measured range rather than against a round number — on the 1 GB
 * board, io pressure reads:
 *
 * | quiet | settling after a deploy | degrading | the day it went off the network |
 * | ----- | ----------------------- | --------- | ------------------------------- |
 * | 9%    | 25–47%                  | 56%       | 83%                             |
 *
 * So 70% is the line: well above anything a busy-but-fine board produces, well
 * below the state that needed a power cycle. Memory's own stall share is the
 * second signal and a quieter one — 2% quiet, 14–28% while degrading.
 *
 * Neither is "memory used" or "CPU busy", and that is the point — during that
 * outage the board reported half a gigabyte available and an idle CPU while
 * every service waited on the disk. A conventional threshold would have said
 * nothing.
 */
export const IO_PRESSURE_LIMIT = 70;
export const MEMORY_PRESSURE_LIMIT = 50;

/**
 * How many consecutive five-minute ticks of that before it is reported.
 *
 * A boot starts two dozen containers at once and a deploy restarts them; both
 * peg the disk legitimately for several minutes, and neither is worth waking
 * somebody for. Three ticks is fifteen minutes of a board that is not
 * recovering on its own — the outage this exists for held for over thirty.
 */
export const PRESSURE_TICKS = 3;

/** The window the per-cgroup reclaim figures are measured over. */
export const PRESSURE_SAMPLE_SECONDS = 10;

/**
 * The deploy layer's file: the URL a message is POSTed to, or nothing. Written
 * even when there is no sink, for the same reason every other `/etc/keel` input
 * is — a present-and-empty file and an absent one have to converge alike, and
 * the script treats both as "say nothing".
 */
export function renderAlertConfig(sink: AlertSink | undefined): string {
  return sink === undefined
    ? "# This installation names no alert sink, so failures are not posted anywhere.\n"
    : `NTFY_URL=${sink.url.replace(/\/+$/, "")}/${sink.topic}\n`;
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
      # Its own file rather than a key in the one above, whose shape is unit ->
      # reason and is written by a board that may already have one on disk.
      PRESSURE_STATE = os.path.join(
          os.environ.get("STATE_DIRECTORY", "/var/lib/keel"), "pressure-state.json"
      )
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


      def save_pressure_state(state):
          tmp = PRESSURE_STATE + ".tmp"
          with open(tmp, "w") as handle:
              json.dump(state, handle, sort_keys=True)
          os.replace(tmp, PRESSURE_STATE)


      def pressure():
          """Stall shares over the last 300s, as percentages.

          PSI and not "memory used", because the failure this watches is
          invisible to the ordinary numbers: a board recycling its page cache to
          death reports gigabytes available and idle CPU while every service
          waits on the disk. "some" rather than "full" — one task stalled is the
          condition, and "full" only counts moments when nothing at all could run.
          """
          found = {}
          for kind in ("io", "memory", "cpu"):
              try:
                  with open("/proc/pressure/" + kind) as handle:
                      for line in handle:
                          if line.startswith("some "):
                              for field in line.split():
                                  name, _, value = field.partition("=")
                                  if name == "avg300":
                                      found[kind] = float(value)
              except (OSError, ValueError):
                  pass
          return found


      def reclaimers(seconds=${PRESSURE_SAMPLE_SECONDS}):
          """Which cgroups are reclaiming, MB over the sample, biggest first.

          The whole point of the alert: "the board is struggling" is a fact a
          person can already feel, and this is the sentence that says which
          service to look at. Sampled only once the threshold is already crossed,
          so an ordinary tick reads three files and stops.
          """
          import glob
          import time

          def snapshot():
              totals = {}
              for path in glob.glob("/sys/fs/cgroup/keel.slice/*/*.service/memory.stat") + [
                  "/sys/fs/cgroup/system.slice/memory.stat"
              ]:
                  name = os.path.basename(os.path.dirname(path)).replace(".service", "")
                  try:
                      with open(path) as handle:
                          totals[name] = sum(
                              int(line.split()[1])
                              for line in handle
                              if line.startswith("pgsteal_")
                          )
                  except (OSError, ValueError, IndexError):
                      pass
              return totals

          first = snapshot()
          time.sleep(seconds)
          second = snapshot()
          moved = [
              (name, (second[name] - first[name]) * 4096 // 1048576)
              for name in second
              if name in first and second[name] > first[name]
          ]
          moved.sort(key=lambda pair: pair[1], reverse=True)
          return [pair for pair in moved if pair[1] > 0][:5]


      def load_pressure_state():
          try:
              with open(PRESSURE_STATE) as handle:
                  return json.load(handle)
          except (FileNotFoundError, ValueError):
              return {"ticks": 0, "reported": False}


      def check_pressure(host, url):
          """Report sustained stall, once, with the cgroups responsible.

          Counted in consecutive ticks rather than fired on one reading: a boot
          starts two dozen containers at once and a deploy restarts them, both of
          which peg this legitimately for a few minutes. ${PRESSURE_TICKS} ticks is
          ${PRESSURE_TICKS * 5} minutes of a board that is not recovering on its own.
          """
          now = pressure()
          over = [
              kind
              for kind, limit in (("io", ${IO_PRESSURE_LIMIT}), ("memory", ${MEMORY_PRESSURE_LIMIT}))
              if now.get(kind, 0) >= limit
          ]
          state = load_pressure_state()

          if not over:
              if state["reported"]:
                  title = host + ": pressure back to normal"
                  body = " ".join("%s %.0f%%" % (k, v) for k, v in sorted(now.items()))
                  print("keel-alert: " + title)
                  if url is None or post(url, title, body, "default", "white_check_mark"):
                      state = {"ticks": 0, "reported": False}
              else:
                  state["ticks"] = 0
              save_pressure_state(state)
              return

          state["ticks"] += 1
          if state["ticks"] < ${PRESSURE_TICKS} or state["reported"]:
              save_pressure_state(state)
              return

          worst = reclaimers()
          lines = [
              "stalled: " + ", ".join("%s %.0f%%" % (k, v) for k, v in sorted(now.items())),
              "load: " + open("/proc/loadavg").read().split(" a")[0].strip(),
              "",
              "reclaiming most (MB/${PRESSURE_SAMPLE_SECONDS}s):",
          ]
          lines += ["  %s %s" % (name, mb) for name, mb in worst] or ["  (nothing measurable)"]
          title = host + ": under sustained " + "/".join(over) + " pressure"
          print("keel-alert: " + title)
          if url is None or post(url, title, "\\n".join(lines), "high", "warning"):
              state["reported"] = True
          save_pressure_state(state)


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
          check_pressure(host, url)
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
