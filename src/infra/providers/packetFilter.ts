/**
 * The ports the kernel actually admits, as a Pulumi resource.
 *
 * `nftables.service` belongs to the image; what Pulumi owns is the drop-ins it
 * reads and the reload that makes it read them. That used to be a
 * `SystemdUnit` with `action: "reload"` whose `trigger` was a hash of the
 * drop-ins' bodies — which is a question about *files*, and the thing that goes
 * wrong is about the *kernel*.
 *
 * The two come apart whenever the table is rebuilt from something other than
 * the current files. A board booting a fresh image is the case that bit: at
 * boot `nftables.service` reads `/etc/keel/nft.d/*.nft`, the deploy's
 * `50-services.nft` is not there yet, and the sets come up empty. The deploy
 * then writes that file with bytes identical to the ones the previous
 * installation had, so a content hash is unchanged, so no reload is planned —
 * and the board sits there with :443 dropped while every other resource reports
 * success. It took a hand-run `systemctl reload nftables` to find.
 *
 * So this resource's `read` asks the board what is in the sets, and its input is
 * what the deployed set says should be. A difference is a reload, whether it
 * came from an edited catalog, a hand-flushed table or a boot that happened
 * before the files existed. `trigger` stays beside it for the half a set cannot
 * answer for: the forward chain's rules are rules rather than set elements, so
 * those still reload on a change in the bytes they are rendered from.
 *
 * `delete` does nothing, for the reason the old resource's did: the filter is
 * the image's and a `pulumi destroy` has no business turning it off. The
 * drop-ins are deleted by their own resources, and the reload that would empty
 * the sets is the next deploy's.
 */

import * as pulumi from "@pulumi/pulumi";

import { run, runOk } from "../ssh";
import { type Args } from "./inputs";

export type PacketFilterInputs = {
  /** ssh_config alias. */
  host: string;
  /**
   * The set elements the deployed set asks for, canonically rendered —
   * `nftSetElements` in `src/render/nftPorts.ts` builds it, and `applied()`
   * below builds the same string out of the board's answer.
   */
  sets: string;
  /** Hash of the drop-in bodies, for the rules no set can stand in for. */
  trigger: string;
  sshArgs?: readonly string[];
};

type Outs = PacketFilterInputs & { applied: string };

/** The table the image ships and this resource speaks for. */
const TABLE = ["inet", "keel"] as const;

/**
 * What the board holds, in the same form the input is written in.
 *
 * `nft -j` rather than the human listing: the text output puts handles and
 * whitespace in places that change between kernel versions, and a diff that
 * moved because a formatter did would reload the filter on every deploy.
 * Returns `null` when the table is not there at all, which is a board that has
 * never booted this image rather than one whose ports drifted.
 */
const applied = async (inputs: PacketFilterInputs): Promise<string | null> => {
  const result = await run(
    inputs.host,
    ["nft", "-j", "list", "table", ...TABLE],
    undefined,
    inputs.sshArgs,
  );
  if (result.status !== 0) return null;
  let parsed: { nftables?: { set?: { name?: string; elem?: unknown[] } }[] };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    return null;
  }
  const found = new Map<string, string>();
  for (const item of parsed.nftables ?? []) {
    const set = item.set;
    if (set?.name === undefined) continue;
    const ports = (set.elem ?? [])
      // libnftables writes a plain value for a bare element and wraps it in an
      // object once the element carries anything of its own — a timeout, a
      // counter, a comment. These sets carry none, so the bare form is what
      // arrives; the wrapper is read anyway, because the alternative when it
      // does appear is a set that reads as empty and a reload on every deploy.
      .map((element) =>
        typeof element === "object" && element !== null && "val" in element
          ? (element as { val: unknown }).val
          : element,
      )
      .filter((element): element is number => typeof element === "number")
      .sort((a, b) => a - b);
    found.set(set.name, ports.join(", "));
  }
  // Keyed off the input's own set names, so the answer is about the sets this
  // resource claims and not about every set the image happens to declare — the
  // address ranges `keel-firstboot` writes live in the same table and are
  // nobody's business here.
  return inputs.sets
    .split("\n")
    .map(
      (line) =>
        `${line.slice(0, line.indexOf("="))}=${found.get(line.slice(0, line.indexOf("="))) ?? ""}`,
    )
    .join("\n");
};

/**
 * Rebuild the table from the files on disk.
 *
 * `reload` and not `restart`: the unit's own `ExecReload` flushes keel's table
 * and re-reads it in one transaction, where a restart would take the whole
 * ruleset down and back up — including, for the length of it, the policy-drop
 * table that is the only thing standing between this board and the network.
 */
const reload = async (inputs: PacketFilterInputs): Promise<void> => {
  await runOk(inputs.host, ["systemctl", "reload", "nftables.service"], undefined, inputs.sshArgs);
};

const provider: pulumi.dynamic.ResourceProvider<PacketFilterInputs, Outs> = {
  async create(inputs) {
    await reload(inputs);
    return {
      id: `${inputs.host}:nftables`,
      outs: { ...inputs, applied: (await applied(inputs)) ?? "" },
    };
  },

  async read(id, props) {
    const known: PacketFilterInputs = props ?? {
      host: id.slice(0, id.indexOf(":")),
      sets: "",
      trigger: "",
    };
    const live = await applied(known);
    // No table is not a drifted table: the image that declares it is not
    // booted, and re-creating this resource would reload a unit that has
    // nothing to read. Pulumi drops it from state and the next `up` creates it
    // against a board that answers.
    if (live === null) return { id: undefined };
    return { id, props: { ...known, applied: live } };
  },

  async diff(_id, olds, news) {
    return {
      changes:
        olds.trigger !== news.trigger ||
        olds.sets !== news.sets ||
        // The half a content hash cannot see. `olds.applied` is the last read of
        // the board, so this is what turns "the kernel does not hold what the
        // catalog asks for" into work rather than into a plan that says nothing.
        olds.applied !== news.sets,
      replaces: olds.host !== news.host ? ["host"] : [],
      deleteBeforeReplace: true,
    };
  },

  async update(_id, _olds, news) {
    await reload(news);
    return { outs: { ...news, applied: (await applied(news)) ?? "" } };
  },

  async delete() {
    // Nothing. See the header: the filter is the image's.
  },
};

/** Exported so the decisions above are assertions rather than prose. */
export const packetFilterProvider = provider;

export class PacketFilter extends pulumi.dynamic.Resource {
  declare public readonly applied: pulumi.Output<string>;

  constructor(name: string, args: Args<PacketFilterInputs>, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, { ...args, applied: undefined }, opts);
  }
}
