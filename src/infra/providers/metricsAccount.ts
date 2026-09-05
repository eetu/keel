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
 * **The hub is talked to from the board, over ssh, the way every other provider
 * here reaches a device.** The hub answers on the board's own loopback, which is
 * where the consumer reads it too — so there is one address for it rather than a
 * second one that only the deploy machine uses, and no assumption that a laptop
 * can route to the LAN at all. Each method sends one small Python program to the
 * board's `python3` on stdin and reads a JSON line back: one ssh session that
 * waits for the hub, authenticates, and does the whole operation, rather than a
 * session per HTTP call.
 *
 * **Everything sensitive rides in on that stdin**, base64 inside the program
 * text: the superuser's two values and the generated password are never an
 * argument, never a file on the board, and never in an error message. `ps` on
 * the board sees `python3 -`. The script prints an id and nothing else, and
 * fails with a short diagnostic that names the operation and an HTTP status.
 *
 * The shape is `SealedEnv`'s: the plaintext is a local inside the method, never
 * an input, never an output and never captured — a captured secret is
 * serialised into state in plaintext (pulumi/pulumi#8265). What is carried is
 * ciphertext the state cannot open and a hash of what it holds, which is what
 * the consuming unit's restart trigger folds in.
 *
 * Everything here runs on `create`, `update`, `read` and `delete` — so on `up`
 * and on `refresh`, and **never on a bare preview**: no vault read, no ssh, no
 * account created by a plan nobody applied.
 *
 * It names no product. Which paths a hub answers on comes in as the metrics
 * role's `api`, so this is "create an account on the hub" and the dialect
 * belongs to the entry that claims the role.
 */

import * as pulumi from "@pulumi/pulumi";

import { type MetricsApi } from "../../config/spec";
import { seal } from "../age";
import { run } from "../ssh";
import { envLine, readField } from "../vault";
import { type Args } from "./inputs";

export type MetricsAccountInputs = {
  /** ssh_config alias of the board the hub runs on — where these calls are made from. */
  host: string;
  /** The 1Password vault the hub's item lives in. */
  vault: string;
  /** The hub's own item, holding the superuser login this authenticates as. */
  item: string;
  /** The hub's loopback origin, which is where the board reaches it. */
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
  sshArgs?: readonly string[];
};

type Outs = MetricsAccountInputs & {
  /** age ciphertext. Safe in state; the identity that opens it is on the host. */
  ciphertext: string;
  /** sha256 of the plaintext. What the consumer's restart trigger folds in. */
  plaintextHash: string;
  /** The hub's id for the account, which is also this resource's id. */
  userId: string;
};

/**
 * How long the board waits for the hub before giving up. The wait is inside the
 * remote program, so thirty attempts are one ssh session rather than thirty.
 */
const HEALTH_ATTEMPTS = 30;
const HEALTH_PAUSE_SECONDS = 2;

/**
 * What every remote program starts with: the payload, one request helper, the
 * wait for the hub and the superuser login.
 *
 * Written flush against the left margin and joined line by line rather than
 * interpolated into an indented template, which is the trap `selftest.ts`
 * documents — an indented block would give its first line a different
 * indentation from the rest, and in Python that is a syntax error rather than an
 * ugly file.
 */
const PREAMBLE = `
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

P = json.loads(base64.b64decode(PAYLOAD).decode("utf-8"))


def fail(what):
    # Short, and never the payload: this reaches a deploy's output.
    sys.stderr.write(what + "\\n")
    raise SystemExit(1)


def call(path, method="GET", body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(P["hub"] + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=30) as answer:
        raw = answer.read()
    return json.loads(raw) if raw else {}


def serving():
    # The hub's start job means healthy, but a deploy can reach this the moment
    # the container came up — so wait rather than conclude the account is absent.
    seen = "no answer"
    for attempt in range(P["attempts"]):
        if attempt:
            time.sleep(P["pause"])
        try:
            call(P["api"]["health"])
            return
        except Exception as error:
            seen = type(error).__name__
    fail("not answering %s after %ds (%s)" % (P["api"]["health"], P["attempts"] * P["pause"], seen))


def token():
    # The hub keeps its superusers in a collection of their own, so an account
    # created here under that same address would be a second thing wearing the
    # bootstrap login's name.
    if P["email"] == P["identity"]:
        fail("the account's address is the hub's own superuser login")
    try:
        return call(P["api"]["superuserAuth"], "POST", {"identity": P["identity"], "password": P["secret"]})["token"]
    except urllib.error.HTTPError as error:
        fail("superuser login refused: HTTP %d" % error.code)


def find(auth):
    where = urllib.parse.quote('email="%s"' % P["email"])
    found = call("%s?filter=%s" % (P["api"]["users"], where), token=auth)["items"]
    return found[0]["id"] if found else None
`;

/**
 * Create or update the account, then assign it to every machine the hub knows.
 *
 * Assigning to everything is what makes this an account of the *hub* rather than
 * of a list somebody maintains: a board added to the fleet tomorrow is visible
 * to the page at the next deploy, and there is nothing to add it to by hand.
 */
const PROVISION = `
serving()
auth = token()
uid = find(auth)
account = {
    "password": P["password"],
    "passwordConfirm": P["password"],
    # The hub mails a confirmation to an address nobody reads, and an unverified
    # account cannot log in at all.
    "verified": True,
    "role": P["role"],
}
try:
    if uid is None:
        account.update({"email": P["email"], "emailVisibility": False})
        uid = call(P["api"]["users"], "POST", account, auth)["id"]
    else:
        call("%s/%s" % (P["api"]["users"], uid), "PATCH", account, auth)
except urllib.error.HTTPError as error:
    fail("could not write the account: HTTP %d" % error.code)
try:
    for machine in call("%s?perPage=200" % P["api"]["systems"], token=auth)["items"]:
        seen = machine.get("users") or []
        if uid in seen:
            continue
        call("%s/%s" % (P["api"]["systems"], machine["id"]), "PATCH", {"users": seen + [uid]}, auth)
except urllib.error.HTTPError as error:
    fail("could not assign the account to a system: HTTP %d" % error.code)
sys.stdout.write(json.dumps({"id": uid}))
`;

/** Whether the account is still there, which is the whole of this resource's `read`. */
const LOOKUP = `
serving()
sys.stdout.write(json.dumps({"id": find(token())}))
`;

/** Remove it. Already gone is the state this was asking for. */
const REMOVE = `
serving()
auth = token()
try:
    call("%s/%s" % (P["api"]["users"], P["userId"]), "DELETE", None, auth)
except urllib.error.HTTPError as error:
    if error.code != 404:
        fail("could not delete the account: HTTP %d" % error.code)
sys.stdout.write(json.dumps({}))
`;

/**
 * The superuser's login, read from the vault for the length of one call.
 *
 * Loudly on an empty field, for the reason `readEnvFile` is: `readField` answers
 * "" for a missing field *and* for an unreachable vault, and a login sent blank
 * is a hub that refuses it for a reason nobody could guess from here.
 */
async function credentials(
  props: MetricsAccountInputs,
): Promise<{ identity: string; secret: string }> {
  const read = async (field: string): Promise<string> => {
    const value = await readField(props.vault, props.item, field);
    if (value === "") {
      throw new Error(`${props.item}/${field} is empty or unreadable`);
    }
    return value;
  };
  return {
    identity: await read(props.superuser.user),
    secret: await read(props.superuser.password),
  };
}

/**
 * One operation on the hub: the program and everything it needs, on the board's
 * stdin, and a JSON answer back.
 *
 * The payload is base64 inside the source rather than a second thing on stdin,
 * because `python3 -` reads its program to EOF and there would be nothing left
 * for the program to read. Encoding it also means no value from the vault is
 * ever spliced into Python source as a literal.
 */
async function speak<T>(
  props: MetricsAccountInputs,
  operation: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const { Buffer } = await import("node:buffer");
  const superuser = await credentials(props);
  const payload = Buffer.from(
    JSON.stringify({
      hub: props.hubUrl,
      api: props.api,
      email: props.email,
      role: props.role,
      identity: superuser.identity,
      secret: superuser.secret,
      attempts: HEALTH_ATTEMPTS,
      pause: HEALTH_PAUSE_SECONDS,
      ...extra,
    }),
    "utf8",
  ).toString("base64");

  const result = await run(
    props.host,
    ["python3", "-"],
    [`PAYLOAD = "${payload}"`, PREAMBLE, body].join("\n"),
    props.sshArgs,
  );
  if (result.status !== 0) {
    // The script's own diagnostic, which is a sentence and a status code. Never
    // its stdout: an answer this could not parse is not something to quote.
    throw new Error(
      `the metrics hub at ${props.hubUrl} could not ${operation}: ` +
        `${result.stderr.trim() || "(no output)"}`,
    );
  }
  return JSON.parse(result.stdout) as T;
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

/** The account, and the login for it sealed for the board that will read it. */
async function provision(inputs: MetricsAccountInputs): Promise<{ id: string; outs: Outs }> {
  const password = await generate();
  const account = await speak<{ id: string }>(inputs, "create the account", PROVISION, {
    password,
  });
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
    const found = await speak<{ id: string | null }>(props, "look the account up", LOOKUP);
    // Deleted in the hub's UI is deleted here too, and the next `up` creates it
    // again with a fresh password.
    if (found.id === null) return { id: undefined };
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
    // change anybody's password. Neither is the board being reached differently:
    // `host` and `sshArgs` are how this gets there, not what it does.
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
    await speak(props, "delete the account", REMOVE, { userId: props.userId });
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
