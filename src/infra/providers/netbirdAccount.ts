/**
 * The first account on the mesh coordinator, claimed by the deploy — and the
 * upstream identity provider its own broker federates to.
 *
 * A coordinator boots unclaimed: it reports that setup is required and answers
 * one unauthenticated call, which creates the owner and — with the server's
 * setup-token option enabled — hands back a plaintext access token. That token
 * is what every later call against the coordinator authenticates as, so unlike
 * every other credential here it cannot stay inside the resource that made it.
 *
 * **This is the second place this repository puts a secret in Pulumi state**,
 * and the first that puts one there in the plain sense: the coordinator's own
 * configuration keys are drawn by `@pulumi/random` and sealed for the board, so
 * the checkpoint holds them under the stack passphrase; this token is a
 * `pulumi.secret` output, held the same way. There is no alternative. The token
 * is minted by the server and shown exactly once, and keel makes no vault
 * writes — so the choice is state or nowhere, and nowhere means every later
 * call needs a person to paste something. `state/` is gitignored and
 * Syncthing-carried, and the stack passphrase is what stands between it and
 * this token, the same trade the coordinator's store key already makes.
 *
 * The owner's password is generated here and kept beside it, for one reason:
 * the token expires — the server caps it at a year — and when it does, the only
 * way back into the account that can mint another is the local login this
 * password is half of. An SSO login through the identity provider lands in a
 * *different* account, because the broker keys an identity on the subject its
 * connector issues and a federated subject can never equal a local one. Throwing
 * the password away would make an expired token a store you have to wipe.
 *
 * **The coordinator is talked to from the board, over ssh**, the way
 * `metricsAccount.ts` reaches the hub and for the same reason: the API answers
 * on the board's own loopback, which is where the deploy's own configuration
 * points it, and no laptop's routing table is assumed to reach the LAN. Each
 * method sends one Python program to the board's `python3` on stdin and reads a
 * JSON line back. Everything sensitive rides in on that stdin, base64 inside the
 * program text — never an argument, never a file on the board, never in a
 * diagnostic. `ps` there sees `python3 -`.
 *
 * Which paths the coordinator answers on come in as the entry's `api`, so this
 * module names no product's URLs. What it does spell out is the body of the two
 * calls it exists to make: claiming an account and registering a connector are
 * its whole subject, not a dialect it is passing through.
 *
 * **The one place `create` cannot converge.** Every other provider here re-adopts
 * what a lost refresh forgot, because writing the same bytes again is free. This
 * one cannot: an account that already exists will not be claimed twice and the
 * token it answered with was shown once. So a `create` that finds the coordinator
 * already claimed and has no token to adopt fails by name, and the message is
 * the whole recovery — mint a personal access token in the dashboard and put it
 * in the vault field the entry names. That field is checked *first*, before the
 * setup call, so the manual path exists whether or not the automatic one worked.
 */

import * as pulumi from "@pulumi/pulumi";

import { type BootstrapApi } from "../../config/spec";
import { run } from "../ssh";
import { readField } from "../vault";
import { type Args } from "./inputs";

export type BootstrapAccountInputs = {
  /** ssh_config alias of the board the coordinator runs on — where these calls are made from. */
  host: string;
  /** The coordinator's loopback origin, which is where the board reaches it. */
  apiUrl: string;
  /** The paths this takes, from the entry that declares the bootstrap. */
  api: BootstrapApi;
  /** The address the owner account is created under. */
  email: string;
  /** The owner's display name on it. */
  name: string;
  /** How long a minted token lives, in days. The server caps it at 365. */
  tokenDays: number;
  /** The 1Password vault the token's item lives in. */
  vault: string;
  /** Item and field a hand-minted token is read from. Names only; no values. */
  token: { item: string; field: string };
  sshArgs?: readonly string[];
};

type AccountOuts = BootstrapAccountInputs & {
  /**
   * What every later call against the coordinator authenticates as. Secret, and
   * in state — see the module comment for why there is nowhere else.
   */
  accessToken: string;
  /**
   * The local owner's password, or "" when this adopted an account somebody else
   * created. The way back in when the token expires.
   */
  ownerPassword: string;
  /** The coordinator's id for the account, which is also this resource's id. */
  accountId: string;
};

export type BootstrapConnectorInputs = {
  host: string;
  apiUrl: string;
  api: BootstrapApi;
  /** The account's token. Secret, and what authorises the registration. */
  accessToken: string;
  /** The connector's name on the coordinator. It is found again by this. */
  name: string;
  /** The client id it is registered under at the identity provider. */
  clientId: string;
  /** The issuer, from whichever entry claims the identity role. */
  issuer: string;
  vault: string;
  /** Item and field the identity provider filed the client's secret on. */
  secret: { item: string; field: string };
  sshArgs?: readonly string[];
};

type ConnectorOuts = BootstrapConnectorInputs & {
  /** The coordinator's id for the connector, which is also this resource's id. */
  connectorId: string;
  /**
   * sha256 of the client secret this was registered with. A vault value is never
   * an input and the API never shows a connector's secret back, so this is the
   * only record of which secret is live: `read` re-reads the vault, and a hash
   * that no longer matches is reported as a connector that is no longer there.
   */
  secretHash: string;
};

/**
 * How long the board waits for the coordinator before giving up. A first boot
 * migrates the store before it answers, so this is longer than the hub's. The
 * wait is inside the remote program, so it is one ssh session rather than thirty.
 */
const HEALTH_ATTEMPTS = 30;
const HEALTH_PAUSE_SECONDS = 4;

/**
 * What every remote program starts with: the payload, one request helper and the
 * wait for the coordinator.
 *
 * Written flush against the left margin and joined line by line rather than
 * interpolated into an indented template — the trap `selftest.ts` documents,
 * which in Python is a syntax error rather than an ugly file.
 */
const PREAMBLE = `
import base64
import json
import sys
import time
import urllib.error
import urllib.request

P = json.loads(base64.b64decode(PAYLOAD).decode("utf-8"))


def fail(what):
    # Short, and never the payload: this reaches a deploy's output.
    sys.stderr.write(what + "\\n")
    raise SystemExit(1)


def call(path, method="GET", body=None, token=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "%s %s" % (P["api"]["authScheme"], token)
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(P["url"] + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=30) as answer:
        raw = answer.read()
    return json.loads(raw) if raw else {}


def serving():
    # The unit's start job means the healthcheck port answers, which is not the
    # same as the API answering: a first boot migrates the store first. So wait
    # rather than conclude the coordinator is unclaimed.
    seen = "no answer"
    for attempt in range(P["attempts"]):
        if attempt:
            time.sleep(P["pause"])
        try:
            return call(P["api"]["instance"])
        except Exception as error:
            seen = type(error).__name__
    fail("not answering %s after %ds (%s)" % (P["api"]["instance"], P["attempts"] * P["pause"], seen))


def listed(answer):
    # A collection comes back as a bare list or wrapped in one key, depending on
    # the endpoint. Both are read the same way here so neither shape is a crash.
    if isinstance(answer, list):
        return answer
    if isinstance(answer, dict):
        for value in answer.values():
            if isinstance(value, list):
                return value
        return [answer] if answer else []
    return []


def account(token):
    # Doubles as the token's liveness check: a token the coordinator no longer
    # accepts is a 401 here, and one it does accept names the account it belongs
    # to. One call rather than two for the same answer.
    found = listed(call(P["api"]["accounts"], token=token))
    return found[0].get("id", "") if found else ""
`;

/**
 * Claim the account, or adopt the one that is already there.
 *
 * The coordinator's own answer decides which, and nothing else: unclaimed means
 * mint, claimed means adopt the token from the vault. A stored token is only
 * ever consulted in the second case, because a token cannot outlive the store
 * that issued it — a field left over from an installation this one replaced
 * looks exactly like a valid one until the server refuses it, and preferring it
 * would turn a fresh coordinator into a failure a person has to clear by hand.
 * Claimed with no token is the one case that cannot converge, and it fails with
 * the sentence that resolves it.
 */
const CLAIM = `
state = serving()
unclaimed = bool(state.get(P["api"]["requiredKey"]))
minted = False
# A token is worth nothing against a store that never issued it, so an unclaimed
# coordinator is claimed here whatever the vault holds.
token = "" if unclaimed else P["given"]
if unclaimed:
    try:
        answer = call(
            P["api"]["setup"],
            "POST",
            {
                "email": P["email"],
                "password": P["password"],
                "name": P["name"],
                "create_pat": True,
                "pat_expire_in": P["days"],
            },
        )
    except urllib.error.HTTPError as error:
        fail("the setup call was refused: HTTP %d" % error.code)
    token = answer.get("personal_access_token", "")
    if not token:
        fail(
            "the account was created and no token came back — the server's setup-token option "
            "has to be on for the call to mint one, and the entry's env is what sets it"
        )
    minted = True
elif not token:
    fail(
        "the coordinator is already claimed and this deploy has no token for it. Sign in at "
        "the dashboard, mint a personal access token, and put it in the vault item '%s' "
        "field '%s' — an already-claimed coordinator is adopted through that field and "
        "through nothing else." % (P["item"], P["field"])
    )
try:
    found = account(token)
except urllib.error.HTTPError as error:
    if error.code in (401, 403, 404):
        fail(
            "the token in '%s/%s' is not one this coordinator accepts (HTTP %d) — a token for a "
            "store this one replaced looks exactly like this. Replace it with one minted here."
            % (P["item"], P["field"], error.code)
        )
    fail("could not read the account back: HTTP %d" % error.code)
sys.stdout.write(json.dumps({"id": found, "token": token, "password": P["password"] if minted else ""}))
`;

/**
 * Whether the account is still there and which token opens it, which is the
 * whole of this resource's `read`.
 *
 * Two tokens are tried, in this order: the one in the vault field, then the one
 * this resource holds. That order is what makes a hand-minted token arrive by an
 * ordinary deploy — a refresh reads it, the account it names becomes this
 * resource's, and everything ordered behind carries that account from then on.
 * It is the contract `SealedEnv` already has: what the vault says now is read on
 * a refresh, and a value rotated there surfaces as drift.
 *
 * A coordinator reporting itself unclaimed is a store that was wiped or restored
 * from before the account existed — gone, whatever either token says. Nothing
 * here mints: a rotation on every refresh would be a new credential for no
 * change.
 */
const LOOKUP = `
state = serving()
if bool(state.get(P["api"]["requiredKey"])):
    sys.stdout.write(json.dumps({"id": "", "token": ""}))
    raise SystemExit(0)


def opens(candidate):
    # The account this token names, or empty for one the coordinator refuses.
    if not candidate:
        return ""
    try:
        return account(candidate)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403, 404):
            return ""
        fail("could not read the account back: HTTP %d" % error.code)


# The vault's token first: a person pastes one there to name the account they
# sign into, and an ordinary deploy is how that arrives.
for candidate in (P["pasted"], P["given"]):
    found = opens(candidate)
    if found:
        sys.stdout.write(json.dumps({"id": found, "token": candidate}))
        raise SystemExit(0)
sys.stdout.write(json.dumps({"id": "", "token": ""}))
`;

/** Register the upstream identity provider, or correct the one that is there. */
const FEDERATE = `
serving()
payload = {
    "type": "oidc",
    "name": P["name"],
    "issuer": P["issuer"],
    "client_id": P["clientId"],
    "client_secret": P["secret"],
}
try:
    found = None
    for connector in listed(call(P["api"]["connectors"], token=P["given"])):
        if connector.get("name") == P["name"]:
            found = connector
    if found is None:
        found = call(P["api"]["connectors"], "POST", payload, P["given"])
    else:
        call("%s/%s" % (P["api"]["connectors"], found["id"]), "PUT", payload, P["given"])
except urllib.error.HTTPError as error:
    fail("could not register the identity provider: HTTP %d" % error.code)
sys.stdout.write(json.dumps({"id": found.get("id", "")}))
`;

/** Whether the connector is still registered, by the name it was registered under. */
const FIND = `
serving()
try:
    found = ""
    for connector in listed(call(P["api"]["connectors"], token=P["given"])):
        if connector.get("name") == P["name"]:
            found = connector.get("id", "")
except urllib.error.HTTPError as error:
    if error.code in (401, 403):
        # A token this cannot authenticate with is a coordinator this deploy no
        # longer holds. Reported as gone, because the create finds the connector by
        # name and corrects it rather than adding a second one — so re-creating
        # costs one lookup and can never duplicate what is there.
        found = ""
    else:
        fail("could not list the identity providers: HTTP %d" % error.code)
sys.stdout.write(json.dumps({"id": found}))
`;

/**
 * One operation on the coordinator: the program and everything it needs, on the
 * board's stdin, and a JSON answer back.
 *
 * The payload is base64 inside the source rather than a second thing on stdin,
 * because `python3 -` reads its program to EOF and there would be nothing left
 * for the program to read. Encoding it also means no credential is ever spliced
 * into Python source as a literal.
 */
async function speak<T>(
  where: { host: string; apiUrl: string; api: BootstrapApi; sshArgs?: readonly string[] },
  operation: string,
  body: string,
  extra: Record<string, unknown>,
): Promise<T> {
  const { Buffer } = await import("node:buffer");
  const payload = Buffer.from(
    JSON.stringify({
      url: where.apiUrl,
      api: where.api,
      attempts: HEALTH_ATTEMPTS,
      pause: HEALTH_PAUSE_SECONDS,
      ...extra,
    }),
    "utf8",
  ).toString("base64");

  const result = await run(
    where.host,
    ["python3", "-"],
    [`PAYLOAD = "${payload}"`, PREAMBLE, body].join("\n"),
    where.sshArgs,
  );
  if (result.status !== 0) {
    // The script's own diagnostic, which is a sentence and a status code. Never
    // its stdout: an answer this could not parse is not something to quote.
    throw new Error(
      `the coordinator at ${where.apiUrl} could not ${operation}: ` +
        `${result.stderr.trim() || "(no output)"}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

/**
 * A password nobody chose: 32 bytes of `randomBytes`, in the alphabet a URL and
 * a JSON body both carry unchanged.
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
 * Every input, in a stable order, with the outputs and the absent keys left out.
 *
 * A `diff` is handed the stored outputs on one side and the declared inputs on
 * the other, so a comparison has to be over the inputs alone — and over all of
 * them. The ones a diff skips are the ones that go stale in state, and state is
 * what the next `read` is run from: a skipped `host` is a refresh that asks a
 * board this deploy stopped meaning. An undefined value is dropped rather than
 * compared, because an input the caller passed as undefined and one the
 * checkpoint never recorded are the same input.
 */
function shape(props: object, outputs: readonly string[]): string {
  return JSON.stringify(
    Object.entries(props)
      .filter(([key, value]) => value !== undefined && !outputs.includes(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** What each provider's `shape` leaves out: the fields it computes rather than takes. */
const ACCOUNT_OUTPUTS = ["accessToken", "ownerPassword", "accountId"];
const CONNECTOR_OUTPUTS = ["connectorId", "secretHash"];

async function digest(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The hand-minted token, if the vault holds one.
 *
 * Empty is a meaning here rather than an error — it is what says "nothing has
 * been pasted, so claim the coordinator" — which is exactly the ambiguity
 * `readField` carries, since it answers "" for a missing field *and* for a vault
 * it could not reach. What makes that safe is the order in `CLAIM`: an empty
 * answer only ever reaches the setup call, which the coordinator refuses once an
 * account exists. So an unreachable vault costs a run, not an account.
 */
async function given(props: BootstrapAccountInputs): Promise<string> {
  return readField(props.vault, props.token.item, props.token.field);
}

/** Claim or adopt, and everything the outputs are built from. */
async function claim(inputs: BootstrapAccountInputs): Promise<{ id: string; outs: AccountOuts }> {
  const answer = await speak<{ id: string; token: string; password: string }>(
    inputs,
    "claim its first account",
    CLAIM,
    {
      given: await given(inputs),
      password: await generate(),
      email: inputs.email,
      name: inputs.name,
      days: inputs.tokenDays,
      item: inputs.token.item,
      field: inputs.token.field,
    },
  );
  return {
    id: answer.id === "" ? inputs.email : answer.id,
    outs: {
      ...inputs,
      accessToken: answer.token,
      ownerPassword: answer.password,
      accountId: answer.id,
    },
  };
}

/**
 * The two providers are exported because they are what this module is: the
 * resource classes below are a constructor each, and what is worth running
 * against a stub coordinator is the methods. `tests/netbirdAccount.test.ts`
 * calls them directly, over a fake `ssh` that pipes the program to a real
 * `python3` — so the strings tested are the strings a deploy sends.
 */
export const accountProvider: pulumi.dynamic.ResourceProvider<BootstrapAccountInputs, AccountOuts> =
  {
    async create(inputs) {
      return claim(inputs);
    },

    async read(id, props) {
      // Nothing to re-derive from on `pulumi import`: the id names an account on
      // some coordinator, and which one — and with which token — is not in it.
      if (!props) return { id: undefined };
      const found = await speak<{ id: string; token: string }>(
        props,
        "look its account up",
        LOOKUP,
        { given: props.accessToken, pasted: await given(props) },
      );
      // A wiped store or a token the coordinator no longer accepts. The next `up`
      // runs `create`, which claims a fresh coordinator or fails by name against
      // one that is already claimed — which is the message that names the vault
      // field to paste a token into.
      if (found.id === "") return { id: undefined };
      // The token that answered is what this holds from here on: a token pasted
      // into the vault names the account a person signs into, and adopting it
      // here is what carries that account into everything ordered behind. Still
      // nothing minted on a refresh.
      return {
        id: found.id,
        props: { ...props, accountId: found.id, accessToken: found.token },
      };
    },

    async check(_olds, news) {
      const failures: pulumi.dynamic.CheckFailure[] = [];
      if (!news.apiUrl.startsWith("http://") && !news.apiUrl.startsWith("https://")) {
        failures.push({ property: "apiUrl", reason: `${news.apiUrl} is not a URL to dial` });
      }
      for (const [which, path] of Object.entries(news.api)) {
        if (which !== "requiredKey" && which !== "authScheme" && !path.startsWith("/")) {
          failures.push({ property: "api", reason: `${which} is no path: '${path}'` });
        }
      }
      if (!news.email.includes("@")) {
        failures.push({ property: "email", reason: `${news.email} is no address` });
      }
      if (news.tokenDays < 1 || news.tokenDays > 365) {
        failures.push({ property: "tokenDays", reason: "the server caps a token at 365 days" });
      }
      for (const [half, value] of Object.entries(news.token)) {
        // A value here rather than a name would be a plaintext secret on its way
        // into state as an input.
        if (!/^[a-z][a-z0-9_.@-]*$/.test(value)) {
          failures.push({
            property: "token",
            reason: `${half} names no vault ${half}: '${value}'`,
          });
        }
      }
      return { inputs: news, failures };
    },

    async diff(_id, olds, news) {
      // Nothing here replaces. A replacement would claim a second account, which is
      // a call the coordinator refuses once it holds one — so the plan would show a
      // create and the run would fail against the account it was replacing. Which
      // account this is belongs to the coordinator's store and to nothing in this
      // file: pointed at a different store, `read` says so the moment that store
      // reports itself unclaimed, and the next `up` claims it.
      //
      // So a moved input is recorded and never acted on. What that leaves is state
      // that still describes where the board is and which field a token would be
      // read from, which is what the next `read` needs to be right.
      return { changes: shape(olds, ACCOUNT_OUTPUTS) !== shape(news, ACCOUNT_OUTPUTS) };
    },

    async update(_id, olds, news) {
      // The account that exists, described by the inputs that are current. The
      // token and the password are carried through: they were minted once and
      // there is no call that mints them again.
      return { outs: { ...olds, ...news } };
    },

    async delete() {
      // Deliberately nothing. This is the only account of a running mesh: deleting
      // it would strand every enrolled peer, every route and every setup key, and a
      // `pulumi destroy` of a stack is not where that decision belongs. The account
      // stays and a person removes it in the dashboard if that is what they meant.
    },
  };

/** The client secret, read for the length of one call and never an input. */
async function clientSecret(props: BootstrapConnectorInputs): Promise<string> {
  const value = await readField(props.vault, props.secret.item, props.secret.field);
  if (value === "") {
    // Loudly, for the reason `readEnvFile` is: "" is a missing field *and* an
    // unreachable vault, and a connector registered with a blank secret is a
    // login that fails at the token exchange with nothing here having complained.
    throw new Error(
      `${props.secret.item}/${props.secret.field} is empty or unreadable — register '` +
        `${props.clientId}' as a client of the identity provider and put the secret it ` +
        "generates on that field",
    );
  }
  return value;
}

export const connectorProvider: pulumi.dynamic.ResourceProvider<
  BootstrapConnectorInputs,
  ConnectorOuts
> = {
  async create(inputs) {
    const secret = await clientSecret(inputs);
    const answer = await speak<{ id: string }>(inputs, "register its identity provider", FEDERATE, {
      given: inputs.accessToken,
      name: inputs.name,
      issuer: inputs.issuer,
      clientId: inputs.clientId,
      secret,
    });
    return {
      id: answer.id === "" ? inputs.name : answer.id,
      outs: { ...inputs, connectorId: answer.id, secretHash: await digest(secret) },
    };
  },

  async read(id, props) {
    if (!props) return { id: undefined };
    const found = await speak<{ id: string }>(props, "look its connectors up", FIND, {
      given: props.accessToken,
      name: props.name,
    });
    // Gone, and a rotated client secret is one of the two ways: the API never
    // returns a connector's secret, so what is registered cannot be compared
    // against the vault — only the hash this resource wrote down can. A
    // connector whose secret is no longer the client's is not the connector this
    // declared, so it is reported absent and the next `up` registers it again
    // with the value that is current. That re-registration is a PUT on the id
    // that is already there, which is what keeps every federated subject intact.
    if (found.id === "" || (await digest(await clientSecret(props))) !== props.secretHash) {
      return { id: undefined };
    }
    return { id, props };
  },

  async check(_olds, news) {
    const failures: pulumi.dynamic.CheckFailure[] = [];
    if (!news.issuer.startsWith("https://")) {
      failures.push({ property: "issuer", reason: `${news.issuer} is no issuer to trust` });
    }
    for (const [half, value] of Object.entries(news.secret)) {
      if (!/^[a-z][a-z0-9_.@-]*$/.test(value)) {
        failures.push({
          property: "secret",
          reason: `${half} names no vault ${half}: '${value}'`,
        });
      }
    }
    return { inputs: news, failures };
  },

  async diff(_id, olds, news) {
    // No replacement here either, and for a sharper reason than above: a
    // replacement's delete is the one operation this must never perform, so a
    // renamed connector would leave the old one registered and add a second.
    // Every change is an update, which is a PUT on the id that is already there.
    return { changes: shape(olds, CONNECTOR_OUTPUTS) !== shape(news, CONNECTOR_OUTPUTS) };
  },

  async update(_id, olds, news) {
    const secret = await clientSecret(news);
    await speak(news, "correct its identity provider", FEDERATE, {
      given: news.accessToken,
      name: news.name,
      issuer: news.issuer,
      clientId: news.clientId,
      secret,
    });
    return { outs: { ...news, connectorId: olds.connectorId, secretHash: await digest(secret) } };
  },

  async delete() {
    // Deliberately nothing, and this one is load-bearing rather than cautious.
    // The broker mints a federated identity's subject from the user's id *and
    // the connector's*, so a connector deleted and registered again gives every
    // person who has ever signed in a subject the coordinator has never seen —
    // and a subject it does not recognise is a brand new, empty account. One
    // destroy would scatter the mesh's users across as many accounts as there
    // are of them, with no way back. So the connector outlives the stack.
  },
};

export class BootstrapAccount extends pulumi.dynamic.Resource {
  declare public readonly accessToken: pulumi.Output<string>;
  declare public readonly ownerPassword: pulumi.Output<string>;
  declare public readonly accountId: pulumi.Output<string>;

  constructor(
    name: string,
    args: Args<BootstrapAccountInputs>,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(
      accountProvider,
      name,
      { ...args, accessToken: undefined, ownerPassword: undefined, accountId: undefined },
      // The token and the owner's password are the only secrets this repository
      // keeps in state, so they are marked as such here rather than left to a
      // caller to remember: what the checkpoint holds is ciphertext under the
      // stack passphrase, and neither value is ever printed by a plan.
      { ...opts, additionalSecretOutputs: ["accessToken", "ownerPassword"] },
    );
  }
}

export class BootstrapConnector extends pulumi.dynamic.Resource {
  declare public readonly connectorId: pulumi.Output<string>;
  declare public readonly secretHash: pulumi.Output<string>;

  constructor(
    name: string,
    args: Args<BootstrapConnectorInputs>,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(
      connectorProvider,
      name,
      { ...args, connectorId: undefined, secretHash: undefined },
      // The account's token is an input here, so it is in this resource's state
      // as well as in the account's. Marked for the same reason it is there.
      { ...opts, additionalSecretOutputs: ["accessToken"] },
    );
  }
}
