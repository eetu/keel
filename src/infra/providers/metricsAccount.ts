/**
 * An account on the metrics hub, generated where it is used.
 *
 * The dashboard reads the hub's API and needs a login for it. Every other
 * credential in this repository is read out of 1Password and sealed for the
 * host; this one is not, because keel makes **no vault writes** — a generated
 * secret that had to be stored would have needed one, and there is nothing here
 * that could put it there. So the password is created inside `create`, sealed
 * for the host's age identity in the same call, and returned as ciphertext. It
 * exists in exactly two places: the hub's own database and one blob on the
 * board. Not in a vault, not in the state file, not in a log line, and not in
 * anybody's clipboard — which is also the honest description of what a
 * credential only two machines share is worth protecting from.
 *
 * That is the whole argument for generating rather than storing. A person never
 * types this password, so nothing is lost by nobody knowing it; rotating it is
 * a `pulumi up` after the input that governs it moved, and re-creating it after
 * somebody deletes the account in the hub's UI is the next deploy.
 *
 * The shape is `SealedEnv`'s: the plaintext is a local inside the method, never
 * an input, never an output and never captured — a captured secret is
 * serialised into state in plaintext (pulumi/pulumi#8265). What is carried is
 * ciphertext the state cannot open and a hash of what it holds, which is what
 * the consuming unit's restart trigger folds in.
 *
 * Everything here runs on `create`, `update`, `read` and `delete` — so on `up`
 * and on `refresh`, and **never on a bare preview**: no vault read, no HTTP call
 * to the hub, no account created by a plan nobody applied.
 *
 * It names no product. Which paths a hub answers on comes in as the metrics
 * role's `api`, so this is "create an account on the hub" and the dialect
 * belongs to the entry that claims the role.
 */

import * as pulumi from "@pulumi/pulumi";

import { type MetricsApi } from "../../config/spec";
import { seal } from "../age";
import { envLine, readField } from "../vault";
import { type Args } from "./inputs";

export type MetricsAccountInputs = {
  /** The 1Password vault the hub's item lives in. */
  vault: string;
  /** The hub's own item, holding the superuser login this authenticates as. */
  item: string;
  /** The hub's origin, as this machine reaches it — its vhost, through the proxy. */
  hubUrl: string;
  /** The address the account is created under. Derived from the consumer's name. */
  email: string;
  /** What the account may do on the hub, in the hub's own vocabulary. */
  role: string;
  /** The hub's API paths, from the metrics role. */
  api: MetricsApi;
  /** Field names on the hub's item — names only; no values. */
  superuser: { user: string; password: string };
  /** The variables the consuming application reads the account out of. */
  envNames: { user: string; password: string };
  /**
   * Public half of the age identity on the target host. Not a secret: it only
   * lets you encrypt *to* the host.
   */
  ageRecipient: string;
};

type Outs = MetricsAccountInputs & {
  /** age ciphertext. Safe in state; the identity that opens it is on the host. */
  ciphertext: string;
  /** sha256 of the plaintext. What the consumer's restart trigger folds in. */
  plaintextHash: string;
  /** The hub's id for the account, which is also this resource's id. */
  userId: string;
};

/** A record in the hub's account collection, as much of one as this reads. */
type HubUser = { id: string };
/** A monitored machine, and whichever accounts already see it. */
type HubSystem = { id: string; users?: readonly string[] };
type HubList<T> = { items: readonly T[] };

/**
 * How long to wait for the hub to answer before giving up: it is reached through
 * the proxy over its own vhost, and a route written seconds ago may not be live
 * yet even though the container's start job has returned.
 */
const HEALTH_ATTEMPTS = 30;
const HEALTH_PAUSE_MS = 2000;

/**
 * One call to the hub. The token rides as `Authorization` bare, which is what
 * PocketBase issues and expects.
 *
 * Failures name the method and the path and the status, and nothing else: a
 * response body can quote back what was sent, and what is sent here is a
 * password.
 */
async function hub<T>(
  base: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(init.token === undefined ? {} : { Authorization: init.token }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    throw new Error(
      `the metrics hub answered ${response.status} to ${init.method ?? "GET"} ${path}`,
    );
  }
  return (await response.json()) as T;
}

/** Waits for the hub to be serving, so "no account there" cannot mean "not up yet". */
async function awaitHub(base: string, health: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await hub(base, health);
      return;
    } catch (error) {
      if (attempt >= HEALTH_ATTEMPTS) {
        throw new Error(
          `the metrics hub at ${base} is not answering ${health} after ` +
            `${(HEALTH_ATTEMPTS * HEALTH_PAUSE_MS) / 1000}s`,
          { cause: error },
        );
      }
      await new Promise((wake) => setTimeout(wake, HEALTH_PAUSE_MS));
    }
  }
}

/**
 * The superuser's token, and the address it belongs to.
 *
 * The password is read from the vault, spent on one request and dropped. The
 * identity comes back with the token because the account being created must not
 * be the bootstrap superuser's own: on the hub they are two collections, and an
 * account created here that shared that address would be a second thing named
 * after the first.
 */
async function authenticate(
  props: MetricsAccountInputs,
): Promise<{ token: string; identity: string }> {
  const read = async (field: string): Promise<string> => {
    const value = await readField(props.vault, props.item, field);
    if (value === "") {
      throw new Error(`${props.item}/${field} is empty or unreadable`);
    }
    return value;
  };
  const identity = await read(props.superuser.user);
  const auth = await hub<{ token: string }>(props.hubUrl, props.api.superuserAuth, {
    method: "POST",
    body: { identity, password: await read(props.superuser.password) },
  });
  return { token: auth.token, identity };
}

/** The account with this address, or undefined — the hub filters, this does not. */
async function findUser(props: MetricsAccountInputs, token: string): Promise<HubUser | undefined> {
  const filter = encodeURIComponent(`email="${props.email}"`);
  const found = await hub<HubList<HubUser>>(props.hubUrl, `${props.api.users}?filter=${filter}`, {
    token,
  });
  return found.items[0];
}

/**
 * A password nobody chose and nobody will read: 32 bytes of `randomBytes`, in
 * the alphabet a URL and an env file both carry unchanged.
 *
 * `node:crypto` is imported inside the function, the rule `ssh.ts` documents: a
 * native binding at module scope is what the serialiser cannot turn into a
 * `require` call.
 */
async function generate(): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  return randomBytes(32).toString("base64url");
}

/**
 * Creates or updates the account and assigns it to every machine the hub knows,
 * then seals the login for the host.
 *
 * Assigning to everything is what makes this an account of the *hub* rather than
 * of a list somebody maintains: a board added to the fleet tomorrow is visible
 * to the page at the next deploy, and there is nothing to add it to by hand.
 */
async function provision(inputs: MetricsAccountInputs): Promise<{ id: string; outs: Outs }> {
  await awaitHub(inputs.hubUrl, inputs.api.health);
  const { token, identity } = await authenticate(inputs);
  if (inputs.email === identity) {
    throw new Error(
      `${inputs.email} is the hub's own superuser address — an account created here would be ` +
        "a second account wearing the bootstrap login's name",
    );
  }

  const password = await generate();
  const existing = await findUser(inputs, token);
  const account =
    existing === undefined
      ? await hub<HubUser>(inputs.hubUrl, inputs.api.users, {
          method: "POST",
          token,
          body: {
            email: inputs.email,
            password,
            passwordConfirm: password,
            // The hub sends a confirmation mail to an address nobody reads, and
            // an unverified account cannot log in at all.
            verified: true,
            role: inputs.role,
            emailVisibility: false,
          },
        })
      : await hub<HubUser>(inputs.hubUrl, `${inputs.api.users}/${existing.id}`, {
          method: "PATCH",
          token,
          body: { password, passwordConfirm: password, verified: true, role: inputs.role },
        });

  const systems = await hub<HubList<HubSystem>>(
    inputs.hubUrl,
    `${inputs.api.systems}?perPage=200`,
    { token },
  );
  for (const system of systems.items) {
    const seen = system.users ?? [];
    if (seen.includes(account.id)) continue;
    await hub(inputs.hubUrl, `${inputs.api.systems}/${system.id}`, {
      method: "PATCH",
      token,
      body: { users: [...seen, account.id] },
    });
  }

  // The body the container reads, in the variable names the application spells
  // — and the last place the password exists unsealed.
  const sealed = await seal(
    `${envLine(inputs.envNames.user, inputs.email)}\n` +
      `${envLine(inputs.envNames.password, password)}\n`,
    inputs.ageRecipient,
  );
  return { id: account.id, outs: { ...inputs, ...sealed, userId: account.id } };
}

const provider: pulumi.dynamic.ResourceProvider<MetricsAccountInputs, Outs> = {
  async create(inputs) {
    return provision(inputs);
  },

  async read(id, props) {
    // Nothing to re-derive from on `pulumi import`: the id names an account on
    // some hub, and which hub, which vault and which variables it was sealed
    // into are not in it.
    if (!props) return { id: undefined };
    await awaitHub(props.hubUrl, props.api.health);
    const { token } = await authenticate(props);
    const found = await findUser(props, token);
    // Deleted in the hub's UI is deleted here too, and the next `up` creates it
    // again with a fresh password.
    if (found === undefined) return { id: undefined };
    // Everything else is carried through untouched. The password cannot be read
    // back — the hub stores a hash of it, and this holds only ciphertext — and
    // generating a new one on every refresh would rewrite the blob and restart
    // the service that reads it, every run, for no change at all.
    return { id, props };
  },

  async check(_olds, news) {
    const failures: pulumi.dynamic.CheckFailure[] = [];
    if (!news.ageRecipient.startsWith("age1")) {
      failures.push({ property: "ageRecipient", reason: "not an age recipient" });
    }
    if (!news.hubUrl.startsWith("https://") && !news.hubUrl.startsWith("http://")) {
      failures.push({ property: "hubUrl", reason: `${news.hubUrl} is not a URL to dial` });
    }
    for (const [half, field] of Object.entries(news.superuser)) {
      // A value here rather than a field name would be a plaintext secret on its
      // way into state.
      if (!/^[a-z][a-z0-9_.@-]*$/.test(field)) {
        failures.push({
          property: "superuser",
          reason: `${half} names no vault field: '${field}'`,
        });
      }
    }
    for (const [half, variable] of Object.entries(news.envNames)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
        failures.push({
          property: "envNames",
          reason: `${half} is no variable name: '${variable}'`,
        });
      }
    }
    return { inputs: news, failures };
  },

  async diff(_id, olds, news) {
    // A different address, or a hub somewhere else, is a different account — the
    // hub has no rename, so the old record is deleted and a new one created,
    // rather than left behind under a name nothing points at any more. The same
    // reading `DnsRecord` makes of a record's name.
    if (olds.email !== news.email || olds.hubUrl !== news.hubUrl) {
      return { changes: true, replaces: ["email", "hubUrl"], deleteBeforeReplace: true };
    }
    // Everything else that moves is a rotation of the account that already
    // exists, and a deliberate one: an update generates a fresh password and
    // re-seals it, which restarts the service that reads it. The vault's
    // contents are not inputs, and the hub's own paths moving is not a reason to
    // change anybody's password.
    return {
      changes:
        olds.role !== news.role ||
        olds.envNames.user !== news.envNames.user ||
        olds.envNames.password !== news.envNames.password ||
        olds.ageRecipient !== news.ageRecipient,
    };
  },

  async update(_id, _olds, news) {
    // The same account: the two inputs that would make it another one replace
    // this resource instead. So the upsert finds the record it made last time
    // and gives it a password nobody has seen either.
    return { outs: (await provision(news)).outs };
  },

  async delete(_id, props) {
    await awaitHub(props.hubUrl, props.api.health);
    const { token } = await authenticate(props);
    const response = await fetch(`${props.hubUrl}${props.api.users}/${props.userId}`, {
      method: "DELETE",
      headers: { Authorization: token },
    });
    // Already gone is the state this was asking for.
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(`the metrics hub answered ${response.status} to DELETE ${props.api.users}`);
    }
  },
};

export class MetricsAccount extends pulumi.dynamic.Resource {
  declare public readonly ciphertext: pulumi.Output<string>;
  declare public readonly plaintextHash: pulumi.Output<string>;
  declare public readonly userId: pulumi.Output<string>;

  constructor(name: string, args: Args<MetricsAccountInputs>, opts?: pulumi.CustomResourceOptions) {
    super(
      provider,
      name,
      { ...args, ciphertext: undefined, plaintextHash: undefined, userId: undefined },
      opts,
    );
  }
}
