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
 * Two kinds of unit end up here, and `action` is the difference. A service unit
 * is Pulumi's: it is started because this resource exists and stopped when it
 * stops existing. `nftables.service` is the image's: Pulumi only hands it new
 * files and asks it to re-read them, so `action: "reload"` reloads on a change
 * and leaves the unit alone on delete — disabling the packet filter is not a
 * thing a deploy should be able to do.
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
   * `restart` (the default) for a unit this resource owns. `reload` for one the
   * image owns and Pulumi only reconfigures.
   */
  action?: "restart" | "reload";
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
  const argv = restarting
    ? ["systemctl", "restart", inputs.unit]
    : inputs.quadlet
      ? ["systemctl", "start", inputs.unit]
      : ["systemctl", "enable", "--now", inputs.unit];
  await runOk(inputs.host, argv, undefined, inputs.sshArgs);
};

const stateOf = async (inputs: SystemdUnitInputs): Promise<{ active: string; enabled: string }> => {
  assertSafeUnit(inputs.unit);
  const [active, enabled] = await Promise.all([
    run(inputs.host, ["systemctl", "is-active", inputs.unit], undefined, inputs.sshArgs),
    run(inputs.host, ["systemctl", "is-enabled", inputs.unit], undefined, inputs.sshArgs),
  ]);
  return { active: active.stdout.trim(), enabled: enabled.stdout.trim() };
};

const provider: pulumi.dynamic.ResourceProvider<SystemdUnitInputs, Outs> = {
  async create(inputs) {
    await apply(inputs, false);
    return { id: `${inputs.host}:${inputs.unit}`, outs: { ...inputs, ...(await stateOf(inputs)) } };
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
    const exists = await run(
      known.host,
      ["systemctl", "cat", known.unit],
      undefined,
      known.sshArgs,
    );
    if (exists.status !== 0) return { id: undefined };
    return { id, props: { ...known, ...(await stateOf(known)) } };
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
    const stopped = olds.active !== undefined && olds.active !== "active";
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
    return { outs: { ...news, ...(await stateOf(news)) } };
  },

  async delete(_id, props) {
    // A borrowed unit is left running: Pulumi supplied its configuration, not
    // its existence, and the files it was given are deleted by their own
    // resources.
    if (props.action === "reload") return;
    assertSafeUnit(props.unit);
    // Data under /var/lib is deliberately left alone: re-adding the declaration
    // and running `pulumi up` is then a clean rollback.
    const argv = props.quadlet
      ? ["systemctl", "stop", props.unit]
      : ["systemctl", "disable", "--now", props.unit];
    await run(props.host, argv, undefined, props.sshArgs);
  },
};

export class SystemdUnit extends pulumi.dynamic.Resource {
  declare public readonly active: pulumi.Output<string>;
  declare public readonly enabled: pulumi.Output<string>;

  constructor(name: string, args: Args<SystemdUnitInputs>, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, { ...args, active: undefined, enabled: undefined }, opts);
  }
}
