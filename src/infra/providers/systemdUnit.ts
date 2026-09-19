/**
 * A systemd unit's runtime state, as a Pulumi resource.
 *
 * This is where the old repo's 29 hand-written cleanup branches went. Dropping a
 * service from the program deletes this resource, whose `delete` stops and
 * disables the unit — so retiring a service is removing its declaration, not
 * remembering to write an else-branch that stops it.
 *
 * `trigger` is a hash of everything whose change should restart the unit (the
 * quadlet body, the memory drop-in, the secret blob). It replaces the stamp files
 * under `/etc/systemd/system/.*-stamp` and the shell that compared them.
 *
 * Three kinds of unit end up here, and `action` is the difference. A service unit
 * is Pulumi's: it is started because this resource exists and stopped when it
 * stops existing. `nftables.service` is the image's: Pulumi only hands it new
 * files and asks it to re-read them, so `action: "reload"` reloads on a change
 * and leaves the unit alone on delete — disabling the packet filter is not a
 * thing a deploy should be able to do. And a timer-triggered one-shot is Pulumi's
 * too, but its steady state is *inactive*: `action: "load"` makes the manager see
 * it and never starts it, because a deploy is not a reason to run a job and a
 * finished run is not drift.
 */

import * as pulumi from "@pulumi/pulumi";

import { assertSafeUnit, run, runOk } from "../ssh";
import { type Args } from "./inputs";

export type SystemdUnitInputs = {
  /** ssh_config alias. */
  host: string;
  /** Full unit name, e.g. `vaultwarden.service`. */
  unit: string;
  /**
   * Quadlet-generated units are produced by a generator on every
   * `daemon-reload` and cannot be enabled directly — their `[Install]` section
   * does that. Non-quadlet units are enabled explicitly.
   */
  quadlet: boolean;
  trigger: string;
  /**
   * `restart` (the default) for a unit this resource owns and that is meant to be
   * running. `reload` for one the image owns and Pulumi only reconfigures.
   * `load` for one this resource owns whose steady state is inactive — a
   * timer-triggered one-shot, where being loaded is the whole of what a deploy
   * has to make true.
   */
  action?: "restart" | "reload" | "load";
  /** Extra ssh arguments — an alternate config file, a jump host, a port. */
  sshArgs?: readonly string[];
};

type Outs = SystemdUnitInputs & { active: string; enabled: string };

/** `daemon-reload` re-runs every generator, which is what materialises quadlets. */
const daemonReload = async (inputs: SystemdUnitInputs): Promise<void> => {
  await runOk(inputs.host, ["systemctl", "daemon-reload"], undefined, inputs.sshArgs);
};

/**
 * Bring the unit to the declared state. For an owned unit that is a reload of the
 * manager followed by a start or a restart; for a borrowed one it is the unit's
 * own `ExecReload`, and nothing else.
 */
const apply = async (inputs: SystemdUnitInputs, restarting: boolean): Promise<void> => {
  assertSafeUnit(inputs.unit);
  if (inputs.action === "reload") {
    await runOk(inputs.host, ["systemctl", "reload", inputs.unit], undefined, inputs.sshArgs);
    return;
  }
  await daemonReload(inputs);
  // A unit whose steady state is inactive is in its declared state as soon as the
  // manager knows about it. Starting it here would run the job — on the deploy
  // that wrote it and again on every one that touched its trigger — and the whole
  // point of a schedule is that the clock decides.
  if (inputs.action === "load") return;
  const argv = restarting
    ? ["systemctl", "restart", inputs.unit]
    : inputs.quadlet
      ? ["systemctl", "start", inputs.unit]
      : ["systemctl", "enable", "--now", inputs.unit];
  await runOk(inputs.host, argv, undefined, inputs.sshArgs);
};

/**
 * Whether the manager knows the unit, and what it says about it — in one ssh
 * session rather than three.
 *
 * A refresh of this stack reads a couple of hundred resources, and this is the
 * read most of them are. Three sessions each meant three sshd forks, three
 * sudos and three systemctls per unit, several hundred short-lived processes
 * inside a minute — on a board with half a gigabyte to spare that is enough to
 * push it into swap, and a board in swap answers `is-active` slowly enough that
 * the next unit's health check times out. The questions are independent and the
 * answers are three lines, so there was never a reason for them to be three
 * connections.
 *
 * `existing` is first because it is the one whose *status* used to carry the
 * meaning: a unit systemd has never heard of is gone, which is a different
 * thing from one that is merely stopped. Inside one shell that distinction has
 * to be printed rather than exited with, since only the last command's status
 * survives.
 */
const stateOf = async (
  inputs: SystemdUnitInputs,
): Promise<{ existing: boolean; active: string; enabled: string }> => {
  assertSafeUnit(inputs.unit);
  const unit = inputs.unit;
  const result = await run(
    inputs.host,
    [
      "sh",
      "-c",
      // `|| true` on each: systemctl exits non-zero for a unit that is not
      // active or not enabled, which is an answer and not a failure.
      `systemctl cat ${unit} >/dev/null 2>&1 && echo yes || echo no; ` +
        `systemctl is-active ${unit} 2>/dev/null || true; ` +
        `systemctl is-enabled ${unit} 2>/dev/null || true`,
    ],
    undefined,
    inputs.sshArgs,
  );
  const [existing = "", active = "", enabled = ""] = result.stdout.split("\n").map((l) => l.trim());
  return { existing: existing === "yes", active, enabled };
};

const provider: pulumi.dynamic.ResourceProvider<SystemdUnitInputs, Outs> = {
  async create(inputs) {
    await apply(inputs, false);
    const { existing: _existing, ...state } = await stateOf(inputs);
    return { id: `${inputs.host}:${inputs.unit}`, outs: { ...inputs, ...state } };
  },

  async read(id, props) {
    // `props` is absent on `pulumi import`, where the id — `<host>:<unit>` — is
    // all there is.
    const known: SystemdUnitInputs = props ?? {
      host: id.slice(0, id.indexOf(":")),
      unit: id.slice(id.indexOf(":") + 1),
      quadlet: true,
      trigger: "",
    };
    assertSafeUnit(known.unit);
    // A unit systemd has never heard of is gone, not merely stopped — that is
    // the difference between drift and deletion.
    const { existing, ...state } = await stateOf(known);
    if (!existing) return { id: undefined };
    return { id, props: { ...known, ...state } };
  },

  async check(_olds, news) {
    // The same reason `RemoteFile` checks its path: ssh joins its arguments and
    // the remote shell re-parses them, so a unit name with shell syntax in it
    // would be executed rather than acted on.
    const failures: pulumi.dynamic.CheckFailure[] = [];
    try {
      assertSafeUnit(news.unit);
    } catch (error) {
      failures.push({ property: "unit", reason: (error as Error).message });
    }
    return { inputs: news, failures };
  },

  async diff(_id, olds, news) {
    const replaces = [
      ...(olds.unit !== news.unit ? ["unit"] : []),
      ...(olds.host !== news.host ? ["host"] : []),
    ];
    // A unit that is not running is a change, not a steady state. `olds` carries
    // the last read of the machine, so this is what turns a service that died
    // into work for `up` to do rather than drift the plan ignores.
    //
    // Except where inactive IS the steady state. A timer-triggered one-shot is
    // inactive between runs and inactive is what a run that worked leaves behind,
    // so this rule applied to one would make every refresh report drift and every
    // `up` run the job — a forecast fetched, a scan performed, a POST sent,
    // because somebody previewed the stack.
    //
    // And `activating` is not stopped. A unit whose start job is still running
    // is mid-flight, not dead — restarting it kills the start to begin another,
    // which is the worst thing to do to a board that is slow because it is
    // already busy. That is a real loop rather than a hypothetical: a health
    // check that times out under load leaves the unit `activating`, a refresh
    // records it, the `up` that follows restarts the service, the restart
    // re-execs a large binary on a board with no memory to spare, and the next
    // unit's check times out too. `deactivating` and `reloading` are
    // transitional for the same reason. What counts as drift is a unit that has
    // stopped being: `inactive` or `failed`.
    const transitional = ["activating", "deactivating", "reloading"];
    const stopped =
      news.action !== "load" &&
      olds.active !== undefined &&
      olds.active !== "active" &&
      !transitional.includes(olds.active);
    return {
      changes:
        olds.trigger !== news.trigger ||
        olds.action !== news.action ||
        stopped ||
        replaces.length > 0,
      replaces,
      deleteBeforeReplace: true,
    };
  },

  async update(id, _olds, news) {
    await apply(news, true);
    const { existing: _existing, ...state } = await stateOf(news);
    return { outs: { ...news, ...state } };
  },

  async delete(_id, props) {
    // A borrowed unit is left running: Pulumi supplied its configuration, not
    // its existence, and the files it was given are deleted by their own
    // resources.
    if (props.action === "reload") return;
    assertSafeUnit(props.unit);
    // Data under /var/lib is deliberately left alone: re-adding the declaration
    // and running `pulumi up` is then a clean rollback.
    //
    // A `load` unit takes the quadlet branch and that is what it wants: `stop` on
    // an inactive one-shot is a no-op, and on one that happens to be mid-run it
    // is the point — a retired job has no business finishing against a quadlet
    // file being deleted underneath it.
    const argv = props.quadlet
      ? ["systemctl", "stop", props.unit]
      : ["systemctl", "disable", "--now", props.unit];
    await run(props.host, argv, undefined, props.sshArgs);
    // And clear the failed state the stop may have left, because nothing else
    // ever will. A container whose stop exits non-zero — a health check already
    // failing, a SIGTERM the image ignores — lands the unit in `failed`, and a
    // retired service has no resource left to converge it: the quadlet file is
    // deleted by its own resource in the same run, so the generator stops
    // producing the unit and `failed` is all that remains of it. The image's
    // five-minute poller then reports that unit for as long as the board is up.
    // Observed exactly once and immediately: retiring ntfy sent a phone alert
    // for a service that had just been removed on purpose.
    await run(props.host, ["systemctl", "reset-failed", props.unit], undefined, props.sshArgs);
  },
};

/**
 * The provider itself, so the three decisions that are only visible in what it
 * runs — a `load` unit is never started, a `load` unit's inactivity is not drift,
 * and a delete stops whatever is running — are assertions rather than prose. It
 * is the same object the resource is constructed with; exporting it changes
 * nothing about how Pulumi serialises it.
 */
export const systemdUnitProvider = provider;

export class SystemdUnit extends pulumi.dynamic.Resource {
  declare public readonly active: pulumi.Output<string>;
  declare public readonly enabled: pulumi.Output<string>;

  constructor(name: string, args: Args<SystemdUnitInputs>, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, { ...args, active: undefined, enabled: undefined }, opts);
  }
}
