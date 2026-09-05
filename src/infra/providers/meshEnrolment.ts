/**
 * This board's membership of the overlay, as a resource.
 *
 * The daemon is the image's — a package and a unit, like unbound — and what the
 * deploy owns is the one fact the image cannot hold: which mesh this machine is
 * a peer of, under which name, with which key. That is `netbird up`, and it is
 * the whole of this resource.
 *
 * **The key is never an argument and never here.** It reaches the board as an
 * age blob the boot-time decrypt opens, and this hands the client the *path*
 * — `--setup-key-file`, which exists for exactly this. So `ps` on the board
 * shows a path, the state file holds a path, and a diagnostic quotes a path. No
 * value this provider can see is a secret, which is also what keeps it clear of
 * the rule against a dynamic provider capturing one (pulumi/pulumi#8265).
 *
 * **`read` asks the client whether it is connected, and that is what makes a
 * peer deleted in the dashboard come back.** The client's own answer — is this
 * machine talking to a coordinator — is the only honest source: a state file
 * would say "enrolled" about a peer the coordinator has never heard of, and the
 * board would sit off the mesh through every deploy that reported success.
 *
 * **The whole operation is one ssh session.** The script goes in on stdin, so
 * nothing is re-parsed by the remote shell out of an argument list, and the wait
 * for the coordinator to answer happens on the board rather than as a session
 * per attempt. It ends by printing `netbird status --json`, which this parses.
 *
 * Everything runs on `create`, `update`, `read` and `delete` — so on `up` and on
 * `refresh`, and never on a bare preview.
 */

import * as pulumi from "@pulumi/pulumi";

import { assertSafePath, assertSafeUnit, run, runOk } from "../ssh";
import { type Args } from "./inputs";

export type MeshEnrolmentInputs = {
  /** ssh_config alias of the board being enrolled. */
  host: string;
  /** The client, as the image installs it. */
  binary: string;
  /** The daemon's profile directory, exported to every invocation the deploy makes. */
  stateDir: string;
  /** The daemon's unit, started before the client is asked to talk to it. */
  unit: string;
  /**
   * The coordinator's public origin — the address this peer is told to dial,
   * for as long as it stays enrolled. The same string every other peer uses, and
   * the same one the routes are declared against, so the board exercises the
   * path a phone does rather than a shortcut only it has.
   */
  managementUrl: string;
  /** The name the peer registers under, which is the routing peer's own. */
  hostname: string;
  /** Where the decrypted setup key sits on the board. A path, never a value. */
  setupKeyPath: string;
  /** The WireGuard port, or null for the client's own default. */
  wireguardPort: number | null;
  /** Extra ssh arguments — an alternate config file, a jump host, a port. */
  sshArgs?: readonly string[];
};

type Outs = MeshEnrolmentInputs & {
  /** Whether the coordinator was answering this peer when it was last asked. */
  connected: boolean;
  /** The overlay address the coordinator assigned, as the client reports it. */
  address: string;
  /** The peer's name on the overlay, which is `hostname` plus the DNS domain. */
  fqdn: string;
};

/**
 * How long the board waits for the coordinator to accept the peer before the
 * deploy calls it a failure. The wait is inside the remote script, so sixty
 * attempts are one ssh session rather than sixty.
 */
const READY_ATTEMPTS = 60;
const READY_PAUSE_SECONDS = 2;

/** What the client prints. Only the three fields this actually reads. */
type ClientStatus = {
  management?: { connected?: boolean };
  netbirdIp?: string;
  fqdn?: string;
};

/**
 * Every value that reaches the remote script, checked before it is spliced into
 * shell source.
 *
 * The script arrives on stdin rather than as arguments, so nothing here is
 * re-parsed by the login shell out of an ssh argument list — but it is still
 * shell source on the far side, and a value carrying a quote would end the
 * literal it sits in. These charsets have no quote, no space and no shell
 * syntax in them, which is what makes single-quoting sound.
 */
function assertSafeValues(inputs: MeshEnrolmentInputs): void {
  assertSafePath(inputs.binary);
  assertSafePath(inputs.stateDir);
  assertSafePath(inputs.setupKeyPath);
  assertSafeUnit(inputs.unit);
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(inputs.managementUrl)) {
    throw new Error(`not a coordinator origin: ${inputs.managementUrl}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(inputs.hostname)) {
    throw new Error(`not a peer name: ${inputs.hostname}`);
  }
  if (
    inputs.wireguardPort !== null &&
    (!Number.isInteger(inputs.wireguardPort) ||
      inputs.wireguardPort < 1 ||
      inputs.wireguardPort > 65535)
  ) {
    throw new Error(`not a port: ${String(inputs.wireguardPort)}`);
  }
}

const quoted = (value: string): string => `'${value}'`;

/**
 * The script every operation starts with: the profile directory the daemon and
 * the CLI both have to agree on, and a daemon that is running.
 *
 * `systemctl start` on an active unit is a no-op, which is the property that
 * makes this converge — and on a board whose booted image predates the agent it
 * fails by name, right here, rather than leaving `netbird up` to report that it
 * cannot reach a daemon nobody installed.
 *
 * Composed line by line rather than interpolated into an indented template: a
 * multi-line block spliced into one gives its first line a different indent from
 * the rest.
 */
function preamble(inputs: MeshEnrolmentInputs): readonly string[] {
  return [
    "set -eu",
    `NB_STATE_DIR=${quoted(inputs.stateDir)}`,
    "export NB_STATE_DIR",
    `systemctl start ${quoted(inputs.unit)}`,
  ];
}

/**
 * Enrol, then wait for the coordinator to actually have this peer.
 *
 * `netbird up` returns as soon as the daemon has accepted the request, which is
 * before the peer is registered — so the start of this resource would mean
 * "asked" rather than "joined", and the routes declared behind it would be
 * looked up against a coordinator that has not seen the peer yet.
 * `status --check startup` is the client's own verdict — management connected,
 * signal connected, a relay available — and waiting on it is what makes this
 * resource's success mean the peer exists rather than that a request was made.
 *
 * `--disable-dns` is load-bearing and not a preference: this board *is* the
 * LAN's resolver, and the client's default is to take `/etc/resolv.conf` over
 * for the overlay's own domain. Every name in the house would then be answered
 * by a resolver that only knows the mesh.
 */
function enrol(inputs: MeshEnrolmentInputs, reconnect: boolean): string {
  const up = [
    quoted(inputs.binary),
    "up",
    `--setup-key-file ${quoted(inputs.setupKeyPath)}`,
    `--management-url ${quoted(inputs.managementUrl)}`,
    `--hostname ${quoted(inputs.hostname)}`,
    ...(inputs.wireguardPort === null ? [] : [`--wireguard-port ${String(inputs.wireguardPort)}`]),
    "--disable-dns",
    // Onto stderr, because the last thing this script writes to stdout is the
    // status document this resource parses — and the client is chatty on a
    // fresh enrolment. `runOk` quotes stderr only when the script fails, which
    // is exactly when that output is worth having.
    ">&2",
  ].join(" ");
  return [
    ...preamble(inputs),
    // `up` short-circuits on an already-connected peer — it prints "Already
    // connected" and exits 0 without reading the key, which is what makes
    // `create` converge on a board that is already a peer. The same
    // short-circuit is why an *update* has to disconnect first: a flag that
    // changed here would otherwise be accepted by the CLI and applied to
    // nothing, and the deploy would report the new port while the peer kept
    // the old one.
    ...(reconnect ? [`${quoted(inputs.binary)} down >/dev/null 2>&1 || true`] : []),
    up,
    "i=0",
    `while [ "$i" -lt ${String(READY_ATTEMPTS)} ]; do`,
    `    if ${quoted(inputs.binary)} status --check startup >/dev/null 2>&1; then`,
    `        exec ${quoted(inputs.binary)} status --json`,
    "    fi",
    "    i=$((i + 1))",
    `    sleep ${String(READY_PAUSE_SECONDS)}`,
    "done",
    `echo "enrolled, and the coordinator has not answered in ${String(
      READY_ATTEMPTS * READY_PAUSE_SECONDS,
    )}s" >&2`,
    "exit 1",
    "",
  ].join("\n");
}

/**
 * What the client currently thinks, or `{}` when there is nothing to ask.
 *
 * A daemon that is not running answers nothing, and so does one that has never
 * been enrolled — both are "this board is not a peer", which is the question.
 * Deliberately does not start the unit: a `read` reports the machine, it does
 * not change it.
 */
function lookup(inputs: MeshEnrolmentInputs): string {
  return [
    "set -eu",
    `NB_STATE_DIR=${quoted(inputs.stateDir)}`,
    "export NB_STATE_DIR",
    `if [ ! -x ${quoted(inputs.binary)} ]; then echo '{}'; exit 0; fi`,
    `if ! systemctl is-active --quiet ${quoted(inputs.unit)}; then echo '{}'; exit 0; fi`,
    `${quoted(inputs.binary)} status --json 2>/dev/null || echo '{}'`,
    "",
  ].join("\n");
}

/**
 * Leave the overlay. The profile stays, so re-declaring this resource re-enrols
 * the same peer rather than minting a second one under the same name.
 *
 * The unit is not stopped: it belongs to the image, the same way
 * `nftables.service` does, and a deploy that no longer declares a peer has said
 * nothing about whether the machine should run the daemon.
 */
function leave(inputs: MeshEnrolmentInputs): string {
  return [
    "set -eu",
    `NB_STATE_DIR=${quoted(inputs.stateDir)}`,
    "export NB_STATE_DIR",
    `if [ ! -x ${quoted(inputs.binary)} ]; then exit 0; fi`,
    `if ! systemctl is-active --quiet ${quoted(inputs.unit)}; then exit 0; fi`,
    `${quoted(inputs.binary)} down >/dev/null 2>&1 || true`,
    "",
  ].join("\n");
}

/** The client's own report of where this board stands, parsed. */
function readStatus(printed: string): Omit<Outs, keyof MeshEnrolmentInputs> {
  let status: ClientStatus;
  try {
    status = JSON.parse(printed.trim() || "{}") as ClientStatus;
  } catch {
    // The client printed something this cannot read, which is not a peer either.
    status = {};
  }
  // Both halves, because either alone lies. A management connection says nothing
  // about this peer having an overlay address, and an address the client
  // remembers is not evidence the coordinator still has the peer that was given
  // it. Which coordinator is deliberately not compared: the client normalises
  // the URL it reports, and a verdict that turned on a trailing `:443` would
  // disconnect and re-enrol the board on every deploy. A coordinator that
  // actually moved is `managementUrl` changing, which `diff` sees.
  const connected = status.management?.connected === true && (status.netbirdIp ?? "") !== "";
  return { connected, address: status.netbirdIp ?? "", fqdn: status.fqdn ?? "" };
}

async function join(inputs: MeshEnrolmentInputs, reconnect: boolean): Promise<Outs> {
  assertSafeValues(inputs);
  const printed = await runOk(inputs.host, ["sh"], enrol(inputs, reconnect), inputs.sshArgs);
  return { ...inputs, ...readStatus(printed) };
}

const provider: pulumi.dynamic.ResourceProvider<MeshEnrolmentInputs, Outs> = {
  async create(inputs) {
    return {
      id: `${inputs.host}:${inputs.hostname}`,
      outs: await join(inputs, false),
    };
  },

  async read(id, props) {
    // Nothing to re-derive on `pulumi import`: the id names a peer on some
    // overlay, and which coordinator, which key and which board are not in it.
    if (!props) return { id: undefined };
    assertSafeValues(props);
    const printed = await runOk(props.host, ["sh"], lookup(props), props.sshArgs);
    const found = readStatus(printed);
    // Gone rather than drifted. A peer deleted in the dashboard, a wiped profile
    // directory and a daemon that never came up all read the same way from here,
    // and all three are repaired by the same thing: the next `up` enrols again.
    if (!found.connected) return { id: undefined };
    return { id, props: { ...props, ...found } };
  },

  async check(_olds, news) {
    const failures: pulumi.dynamic.CheckFailure[] = [];
    try {
      assertSafeValues(news);
    } catch (error) {
      failures.push({ property: "managementUrl", reason: (error as Error).message });
    }
    return { inputs: news, failures };
  },

  async diff(_id, olds, news) {
    const replaces = olds.host !== news.host ? ["host"] : [];
    // Nothing here reads `connected`, unlike `SystemdUnit`'s reading of a unit
    // that died: a peer that is no longer one is already handled a step earlier,
    // because `read` drops the resource outright rather than reporting drift. A
    // second opinion here would fire on every plan that has not refreshed, and
    // what it would do is disconnect a working peer to reconnect it.
    return {
      changes:
        olds.managementUrl !== news.managementUrl ||
        olds.hostname !== news.hostname ||
        olds.wireguardPort !== news.wireguardPort ||
        olds.setupKeyPath !== news.setupKeyPath ||
        olds.stateDir !== news.stateDir ||
        olds.binary !== news.binary ||
        olds.unit !== news.unit ||
        replaces.length > 0,
      replaces,
      deleteBeforeReplace: true,
    };
  },

  async update(_id, _olds, news) {
    // Disconnect first, because the client's own idempotence is what would
    // otherwise swallow the change. See `enrol`.
    return { outs: await join(news, true) };
  },

  async delete(_id, props) {
    assertSafeValues(props);
    await run(props.host, ["sh"], leave(props), props.sshArgs);
  },
};

export class MeshEnrolment extends pulumi.dynamic.Resource {
  declare public readonly connected: pulumi.Output<boolean>;
  declare public readonly address: pulumi.Output<string>;
  declare public readonly fqdn: pulumi.Output<string>;

  constructor(name: string, args: Args<MeshEnrolmentInputs>, opts?: pulumi.CustomResourceOptions) {
    super(
      provider,
      name,
      { ...args, connected: undefined, address: undefined, fqdn: undefined },
      opts,
    );
  }
}
