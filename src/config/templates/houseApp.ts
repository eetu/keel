/**
 * The shape this house's own applications share, as a constructor.
 *
 * One of them is a single image with one port, one SQLite file under
 * `/var/lib/<name>` mounted at `/data`, a vhost of its own, an identity of some
 * kind in front of it, and a cap in the application tier. Written out that is
 * thirty lines, of which six differ between any two of them: the name, what it
 * is, the image, the port, the cap, and how a visitor proves who they are. Those
 * six are the arguments here; everything else is a convention this states once.
 *
 * It returns a plain `ServiceSpec`, so nothing downstream can tell a stamped
 * entry from a literal one — same type, same renderers, same golden, same
 * refusal of a duplicate name. A catalog holds the result rather than a
 * reference to the recipe, so this module can be rewritten without touching a
 * catalog, and an entry that has outgrown the shape is written out as a literal
 * one with nothing downstream noticing. That translation is by hand: `yarn spec
 * <name>` prints an entry *resolved*, so the two URLs the setup composed arrive
 * merged into the environment, and a literal entry composes them from the
 * identity role rather than writing a zone into a catalog.
 * `tests/houseApp.test.ts` holds one stamp's literal equivalent, which is the
 * shape to copy.
 *
 * **It derives what the deployment owns and states nothing about what the
 * application owns.** The mount, the backup, the tier, the vhost, the published
 * port, the network, the OIDC variables and `SESSION_KEY` mean the same thing
 * whichever application is behind them, so they follow from the six facts. The
 * name of the variable an application reads its listen address or its database
 * path out of is that application's vocabulary, and inferring it from a
 * deployment label is a guess that fails silently: a rename in the application
 * leaves the catalog setting a variable nothing reads, the application on its own
 * default path, and its database outside the directory the nightly snapshot
 * covers. So `env` is the entry's alone — passed through, never added to, never
 * read. A bind that contradicts the network is loud where it matters: the proxy
 * dials the port and gets no answer at the first request.
 *
 * Any other `ServiceSpec` field is an override that replaces what would have
 * been derived — `subdomain`, `publicDns`, `egress`, `backup`, `cmd`,
 * `vaultItem`, `dependsOn`, `ingress` and the rest — so a stamp with one
 * exception keeps every other convention. `env`, `secretEnv`, `mounts` and
 * `setup` merge with the derived ones instead, and a variable or a mount claimed
 * by both is an error naming it.
 *
 * **The network follows the login, and is the one convention that does.** An
 * application the edge gate answers for keeps the default: the internal bridge,
 * its port published to the host's loopback, and no route off the host. One that
 * runs its own OIDC client cannot. That flow's back channel — discovery, the
 * token exchange, the JWKS fetch — is made by the application itself, to the
 * issuer, through the issuer's own vhost; every route in the fleet carries an
 * allowlist of the LAN and the mesh, and the packet filter admits :443 from
 * those same two sets. A bridge address is in neither, and the internal bridge
 * has no route off the host at all, so the login would fail at its first use
 * after a deploy that looked clean. So an OIDC stamp shares the host's network
 * stack, exactly as the gate does, and an `egress` override away from it is
 * refused rather than derived around.
 *
 * **What that costs is the isolation, not only the egress.** A process in the
 * host's network namespace reaches the internet, and it also reaches every
 * loopback port on the board — the identity provider's, the vault's, the gate's
 * forward-auth endpoint, every other application's — none of which is behind a
 * route's allowlist or the gate for a caller that never passes through the proxy.
 * On the internal bridge it can reach none of them. So `auth: "edge"` is the
 * posture an application arrives on: the gate holds the only client, the
 * application keeps the bridge, and the identity reaches it in a header.
 * `auth: "oidc"` is for one that has to run the flow itself, and choosing it is
 * choosing to trust that application with the board's loopback.
 *
 * **When to write the entry out instead.** Needing more than two overrides means
 * the entry is not this shape: a stamp plus a list of exceptions reads worse
 * than the thirty lines, and hides what the service actually is. Four kinds are
 * out of scope by construction: a native service, which has no quadlet and no
 * entry at all; a service on another machine, which reaches an entry as a URL
 * composed in that entry's `setup`; a bundle of units that need each other,
 * where one spec is one unit and a sidecar has its own port, state and
 * retirement; and a third-party image, whose released digest, chosen data path
 * and absent session key are none of the conventions here.
 */

import { type SecretRef, type ServiceSetup, type ServiceSpec, type SetupContext } from "../spec";
import { type ServiceMemory } from "../types";
import { OIDC_VARIABLES, oidcClientEnv, oidcClientSecretRef } from "./oidcClient";

/** Where the data directory is mounted inside the container. */
const CONTAINER_DATA_DIR = "/data";

/**
 * The key that signs an application's own session cookie, and the field it is
 * read from. Every one of these applications refuses to start without it unless
 * it is in development mode, because a predictable key is a forgeable session.
 */
const SESSION_KEY_VARIABLE = "SESSION_KEY";
const SESSION_KEY_FIELD = "session_key";

/**
 * The cap, minus the two facts the template knows: the tier is always the
 * application one, and a measurement is not optional here.
 *
 * The budget test holds a cap to at least 1.5x and at most 8x what the service
 * was measured using, and it can only hold the entries that carry a
 * measurement. So a template that let `measuredMb` slide would produce caps
 * nothing checks — quietly removing the only guard there is on a number that is
 * otherwise taste.
 */
export type HouseAppMemory = Omit<ServiceMemory, "tier" | "measuredMb"> & { measuredMb: number };

/** The six facts, and where the data directory is mounted. */
type HouseAppFacts = {
  /** Also the container, the unit, the vhost, the state directory and the vault item. */
  name: string;
  description: string;
  /**
   * A tag, for an image the application's own CI moves; the deploy resolves it to
   * a digest. A reference carrying `@sha256:` is pinned and passes straight through.
   */
  image: string;
  /** What it listens on: the quadlet publishes it and the proxy dials it. */
  port: number;
  memory: HouseAppMemory;
  /**
   * Where `/var/lib/<name>` is mounted, `null` for an application that keeps
   * nothing. The host half is not an option: `backupPath()` derives the snapshot
   * set from the service's name, so a state directory somewhere else would be
   * state the nightly snapshot does not contain.
   */
  dataDir?: string | null;
};

/**
 * How a visitor proves who they are, and the one fact that follows from running
 * an OIDC client: which vault item the provider keeps its generated secrets on.
 * Required by the type rather than defaulted, because a default would be one
 * house's item name read by every other deploy without being told.
 */
type HouseAppAuth =
  { auth: "open" | "edge"; identityItem?: never } | { auth: "oidc"; identityItem: string };

/** The fields the six facts stand in for; everything else on a spec is an override. */
type Derived = "name" | "description" | "image" | "port" | "memory" | "auth";

export type HouseAppOptions = HouseAppFacts & HouseAppAuth & Omit<Partial<ServiceSpec>, Derived>;

/**
 * What every derivation from the name accepts.
 *
 * It becomes a unit and a container name, a DNS label and a directory under
 * `/var/lib`. The DNS label is the narrowest: a name with a dot in it is two
 * labels, an upper-case one is not a label at all, and both reach the device as
 * a route the proxy answers on a vhost nobody typed.
 */
const DERIVABLE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * A record, or nothing at all when it is empty.
 *
 * Load-bearing for `secretEnv`: an empty block there is not the same as none.
 * `secretsPath()` reads presence, so `{}` would give the quadlet an
 * `EnvironmentFile=` pointing at a sealed blob with nothing in it and a start
 * that orders itself after a decrypt with nothing to decrypt.
 */
function nonEmpty<T>(values: Record<string, T>): Record<string, T> | undefined {
  return Object.keys(values).length === 0 ? undefined : values;
}

/** Same, for the lists an entry may simply not have. */
function nonEmptyList<T>(values: readonly T[]): readonly T[] | undefined {
  return values.length === 0 ? undefined : values;
}

/**
 * The template's variables and the entry's own, refusing one claimed twice.
 *
 * Precedence is the alternative, and there is no honest one to pick: a caller
 * silently overriding a derived variable makes the stamp a suggestion, and the
 * template winning discards what the caller asked for. Insertion order is the
 * template's first, because it is what the quadlet's `Environment=` lines are
 * written in and a reordering restarts the container.
 */
function mergeVariables<T>(
  name: string,
  derived: Record<string, T>,
  own: Record<string, T> = {},
  where: string,
): Record<string, T> {
  const merged: Record<string, T> = { ...derived };
  for (const [variable, value] of Object.entries(own)) {
    if (variable in merged) {
      throw new Error(
        `${name} claims ${variable} in both the house-app template and its own ${where} — ` +
          "one variable with two owners has no rule for which of them wins",
      );
    }
    merged[variable] = value;
  }
  return merged;
}

/**
 * A `Volume=` line's host-side source, the half two owners could collide on —
 * without a trailing slash, since `/var/lib/atlas/` and `/var/lib/atlas` are one
 * directory to podman and would otherwise be two sources here.
 */
function mountSource(mount: string): string {
  return mount.split(":")[0].replace(/\/+$/, "");
}

/**
 * The template's mounts and the entry's own, refusing one source claimed twice.
 *
 * Two `Volume=` lines for one source is not a merge quadlet has a rule for —
 * it is two directives with whichever flags happen to land last, so a caller
 * mount that reuses the derived data mount's own source (most likely by
 * copying it to change a flag) is refused by name instead of rendering both.
 */
function mergeMounts(
  name: string,
  derived: readonly string[],
  own: readonly string[] = [],
): readonly string[] | undefined {
  const derivedSources = new Set(derived.map(mountSource));
  for (const mount of own) {
    const source = mountSource(mount);
    if (derivedSources.has(source)) {
      throw new Error(
        `${name} claims ${source} in both the house-app template's own mount and its ` +
          "mounts — one host path with two Volume= lines has no rule for which flags win",
      );
    }
  }
  return nonEmptyList([...derived, ...own]);
}

/** One house application's whole declaration, from the six facts that differ. */
export function houseApp(options: HouseAppOptions): ServiceSpec {
  const {
    name,
    description,
    image,
    port,
    memory,
    auth,
    identityItem,
    dataDir: dataDirOption,
    env,
    secretEnv,
    mounts,
    setup,
    ...overrides
  } = options;
  if (!DERIVABLE_NAME.test(name)) {
    throw new Error(
      `'${name}' is not a name this shape can derive from — it becomes a unit, a DNS label and ` +
        `/var/lib/${name}, and lowercase letters, digits and dashes after a letter are what ` +
        "all three of those accept",
    );
  }

  const dataDir = dataDirOption === undefined ? CONTAINER_DATA_DIR : dataDirOption;

  // An OIDC client's back channel goes to the issuer's vhost, and only an
  // address the route's allowlist admits gets an answer there — which the host's
  // own address is and a bridge's is not. An override away from the host's stack
  // is a login that fails on the device at first use with nothing in the deploy
  // having looked wrong, so it is refused here rather than derived around.
  const egress = overrides.egress ?? (auth === "oidc" ? "host" : "internal");
  if (auth === "oidc" && egress !== "host") {
    throw new Error(
      `${name} runs its own OIDC client and asks for egress '${egress}' — the flow's back ` +
        "channel reaches the issuer through its vhost, whose allowlist and packet filter admit " +
        "the LAN and the mesh, and a bridge address is in neither",
    );
  }

  // A session of its own is signed whichever way the identity arrives — the
  // forward-auth gate authenticates the request, and what the application does
  // with that identity afterwards is its own cookie. Only `open` has none.
  const derivedSecrets: Record<string, SecretRef> = {};
  if (auth !== "open") derivedSecrets[SESSION_KEY_VARIABLE] = SESSION_KEY_FIELD;
  if (auth === "oidc") {
    derivedSecrets[OIDC_VARIABLES.clientSecret] = oidcClientSecretRef(identityItem, name);
  }

  // `U` because the image runs as uid 1000 and the unit makes the directory as root.
  const derivedMounts = dataDir === null ? [] : [`/var/lib/${name}:${dataDir}:Z,U`];

  const subdomain = overrides.subdomain === undefined ? name : overrides.subdomain;

  // The installation-shaped half, which for a stamped entry is the OIDC client's
  // two URLs and whatever the entry composes for itself. Absent entirely when
  // there is neither, so a stamped entry with nothing to say declares no setup.
  const composed = (context: SetupContext): ServiceSetup => {
    const own = auth === "oidc" ? oidcClientEnv(context) : {};
    const caller = setup?.(context) ?? {};
    return {
      env: nonEmpty(mergeVariables(name, own, caller.env, "setup")),
      files: caller.files,
    };
  };

  return {
    name,
    description,
    image,
    port,
    // The tier is not an option: the image's slice budgets are the sum of the
    // core tier's caps, so an application there would change the artefact CI builds.
    memory: { ...memory, tier: "apps" },
    subdomain,
    // A public record is a name for the vhost, so an application with no vhost
    // has nothing to publish — the same reasoning that ties `backup` to the data
    // directory instead of defaulting it on.
    publicDns: subdomain !== null,
    auth,
    // The vhost is the way in, and for a gated application there is no way out:
    // one that genuinely calls the internet overrides this and states why on the
    // entry. A client of the issuer is on the host's stack whatever it says.
    egress,
    // Wholly the entry's: the names are the application's, so nothing is added.
    env: nonEmpty({ ...env }),
    secretEnv: nonEmpty(mergeVariables(name, derivedSecrets, secretEnv, "secretEnv")),
    mounts: mergeMounts(name, derivedMounts, mounts),
    // Whatever is under the data directory is the whole of what a restore has to
    // bring back, so an application that keeps one is in the snapshot set and one
    // that keeps nothing has nothing to snapshot.
    backup: dataDir !== null,
    ...overrides,
    setup: auth === "oidc" || setup !== undefined ? composed : undefined,
  };
}
