/**
 * The identity provider's OAuth2 clients, registered by the deploy — and the
 * administrative account that registers them.
 *
 * **Kanidm generates a client's secret and nothing can set it from outside**, so
 * a registration has a value to hand on that no person typed. It goes into the
 * vault, on the provider's own item, in the field the client's entry already
 * reads (`<client id>_client_secret`): the client's `SealedEnv` is unchanged and
 * a client on another board reads it the same way, once the board that runs the
 * provider has been deployed. **These are the only vault writes this repository
 * makes**, together with the administrative password below, and for one reason:
 * the server mints both, and the vault is where every reader already looks.
 * State holds a hash of the client secret and never the secret.
 *
 * **The account is `recover-account`'s.** A fresh installation's vault has no
 * password for it, and the server image is distroless with a CLI that wants a
 * terminal — so `KanidmAdmin` runs the server's `scripting` form inside its
 * container, which resets the password over the admin socket and prints it as
 * JSON, and writes what it printed into the vault. It does so only when the
 * field is definitely absent: a vault it could not reach is a failed run rather
 * than a reset password nobody knows.
 *
 * **The server is talked to from its own board, over ssh**, the way
 * `netbirdAccount.ts` reaches the coordinator: Kanidm answers TLS on the board's
 * loopback, and no laptop's routing table is assumed to reach the LAN. Each
 * method sends one Python program to the board's `python3` on stdin and reads a
 * JSON line back; the password rides in on that stdin, base64 inside the
 * program text, never an argument and never a diagnostic.
 *
 * **A registration is the exact set it declares** once it is this resource's:
 * the redirect URLs, who may sign in (the scope map), the members of the groups
 * it brings and whether it does PKCE. A client the server already had when it
 * was first declared is adopted by adding to it (see `APPLY`), and the next
 * plan shows what converging would take away. `read` asks the server for each, so a redirect added in the web UI
 * or a scope map changed with the CLI is drift on a refresh, and a secret reset
 * there is too — the vault's copy is compared with the server's by hash, and a
 * client whose secret is no longer the vault's is reported absent so the next
 * `up` adopts it and writes the current one.
 */

import * as pulumi from "@pulumi/pulumi";

import { run } from "../ssh";
import { fieldMissing, readField, writeField } from "../vault";
import type { Args } from "./inputs";

export type KanidmAdminInputs = {
  /** ssh_config alias of the board that runs the identity provider. */
  host: string;
  sshArgs?: readonly string[];
  /** The provider's container, which `podman exec` runs the recovery in. */
  container: string;
  /** The recovery command, inside the container. */
  recover: readonly string[];
  vault: string;
  /** The provider's own vault item, and the field holding the password. */
  item: string;
  field: string;
};

export type KanidmClientInputs = {
  host: string;
  sshArgs?: readonly string[];
  /** The provider's port on the board's loopback. */
  port: number;
  vault: string;
  /** Who registers: the account, and where its password is in the vault. */
  admin: { account: string; item: string; field: string };
  clientId: string;
  displayName: string;
  landing: string;
  redirects: readonly string[];
  scopeMap: Record<string, readonly string[]>;
  groups: Record<string, readonly string[]>;
  pkce: boolean;
  /** Managed only when stated: see `OidcClientSpec`. */
  shortUsername?: boolean;
  /** Where the secret the provider generates is written. */
  secret: { item: string; field: string };
};

type ClientOuts = KanidmClientInputs & {
  /** sha256 of the client secret, which is how a reset is noticed. */
  secretHash: string;
};

/** What the board reports a client as, in the same terms the inputs declare it. */
type Observed = {
  displayName: string;
  landing: string;
  redirects: string[];
  scopeMap: Record<string, string[]>;
  groups: Record<string, string[]>;
  pkce: boolean;
  shortUsername?: boolean;
};

/**
 * How long the board waits for the server, which may be in its first start, and
 * the pause between attempts. The wait is inside the remote program, so it is
 * one ssh session rather than thirty.
 */
const HEALTH_ATTEMPTS = 30;
const HEALTH_PAUSE_SECONDS = 2;

/** How often, and how far apart, a recovery is tried while the container starts. */
const RECOVER_ATTEMPTS = 5;
const RECOVER_PAUSE_MS = 3000;

/**
 * What every remote program starts with: the payload, the request helper, the
 * wait, the sign-in and the reading of a client.
 *
 * Flush against the left margin, for the reason `netbirdAccount.ts` gives: an
 * indented Python template is a syntax error.
 *
 * TLS is not verified on loopback: the server presents the proxy's wildcard for
 * its public name, which 127.0.0.1 is not, and nothing this program sends leaves
 * the board.
 *
 * Scope maps and group members come back naming a group or a person by SPN or
 * by UUID, depending on how the server resolved the value; both are mapped back
 * to the plain names the inputs use, the UUIDs through the entries this program
 * looks up, so a declaration in names is not a diff against an answer in UUIDs.
 */
const PREAMBLE = `
import base64
import hashlib
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

P = json.loads(base64.b64decode(PAYLOAD).decode("utf-8"))
BASE = "https://127.0.0.1:%d" % P["port"]
CONTEXT = ssl._create_unverified_context()
SESSION = "X-KANIDM-AUTH-SESSION-ID"
SHORT = "oauth2_prefer_short_username"
PKCE = "oauth2_allow_insecure_client_disable_pkce"


def fail(what):
    # Short, and never the payload or a body: this reaches a deploy's output.
    sys.stderr.write(what + "\\n")
    raise SystemExit(1)


def call(method, path, body=None, token=None, session=None, missing=False):
    # A JSON content type on a request with no body is one the server may refuse
    # as malformed rather than read as "no body", so it goes only with a body.
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    if session:
        headers[SESSION] = session
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, context=CONTEXT, timeout=30) as answer:
            raw = answer.read()
            return answer.headers.get(SESSION), (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as error:
        if missing and error.code == 404:
            return None, None
        fail("%s %s answered %d" % (method, path.split("?")[0], error.code))


def serving():
    seen = "no answer"
    for attempt in range(P["attempts"]):
        if attempt:
            time.sleep(P["pause"])
        try:
            urllib.request.urlopen(BASE + "/status", context=CONTEXT, timeout=10).read()
            return
        except Exception as error:
            seen = type(error).__name__
    fail("not answering /status after %ds (%s)" % (P["attempts"] * P["pause"], seen))


def login():
    account = P["account"]
    session, _ = call("POST", "/v1/auth", {"step": {"init2": {
        "username": account, "issue": "token", "privileged": True}}})
    session, _ = call("POST", "/v1/auth", {"step": {"begin": "password"}}, session=session)
    _, answer = call("POST", "/v1/auth", {"step": {"cred": {"password": P["password"]}}},
                     session=session)
    state = (answer or {}).get("state") or {}
    if "success" not in state:
        fail("%s was refused (%s): the vault's password is not the server's" % (
            account, ", ".join(state.keys()) or "no answer"))
    return state["success"]


def uuid_of(token, kind, name):
    _, entry = call("GET", "/v1/%s/%s" % (kind, name), token=token, missing=True)
    values = ((entry or {}).get("attrs") or {}).get("uuid") or []
    return values[0] if values else None


def plain(value, names):
    # An SPN's name, or the name a UUID was looked up under, or the value itself.
    return names.get(value, value.split("@", 1)[0])


def observe(token):
    want = P["client"]
    _, entry = call("GET", "/v1/oauth2/" + want["id"], token=token, missing=True)
    if not entry:
        return None
    attrs = entry.get("attrs") or {}
    groups = {}
    for group in want["scopeMap"]:
        found = uuid_of(token, "group", group)
        if found:
            groups[found] = group
    scope_map = {}
    for value in attrs.get("oauth2_rs_scope_map") or []:
        group, _, scopes = value.partition(": ")
        scope_map[plain(group, groups)] = sorted(re.findall(r'"([^"]+)"', scopes))
    members = {}
    for group, declared in want["groups"].items():
        found = members_of(token, group, declared)
        if found is not None:
            members[group] = found
    first = lambda name, default="": (attrs.get(name) or [default])[0]
    state = {
        "displayName": first("displayname"),
        "landing": first("oauth2_rs_origin_landing"),
        "redirects": sorted(attrs.get("oauth2_rs_origin") or []),
        "scopeMap": scope_map,
        "groups": members,
        "pkce": first("oauth2_allow_insecure_client_disable_pkce", "false") != "true",
    }
    if want.get("shortUsername") is not None:
        state["shortUsername"] = first(SHORT, "false") == "true"
    return state


def members_of(token, group, declared):
    # A group's members by plain name, or None when there is no such group.
    if uuid_of(token, "group", group) is None:
        return None
    people = {}
    for person in declared:
        found = uuid_of(token, "person", person)
        if found:
            people[found] = person
    _, values = call("GET", "/v1/group/%s/_attr/member" % group, token=token, missing=True)
    return sorted(plain(value, people) for value in (values or []))


def secret(token):
    _, value = call("GET", "/v1/oauth2/%s/_basic_secret" % P["client"]["id"], token=token)
    if not isinstance(value, str) or not value:
        fail("the server returned no secret for %s" % P["client"]["id"])
    return value
`;

/** The client as the server has it, and its secret's hash, or null when there is none. */
const LOOK = `
serving()
token = login()
state = observe(token)
digest = hashlib.sha256(secret(token).encode("utf-8")).hexdigest() if state else ""
print(json.dumps({"state": state, "secretHash": digest}))
`;

/**
 * Converge the client and the groups it brings to the declaration, and hand the
 * secret back with the state it left, for the vault and for the outputs.
 *
 * **A client or group the server already has, met by `create`, is adopted by
 * adding to it**: the declared redirects, scope maps and members join what is
 * there and nothing is taken away, and PKCE left off stays off. A registration
 * made by hand may hold what somebody needs to sign in, and a create has no
 * plan line that shows it going. What adoption kept is in the outputs, so the
 * next plan shows its removal as an update, for a person to read before it
 * happens; an update converges to the exact set.
 */
const APPLY = `
serving()
token = login()
want = P["client"]
adopting = P["adopting"]
for group, declared in want["groups"].items():
    present = members_of(token, group, declared)
    if present is None:
        call("POST", "/v1/group", {"attrs": {"name": [group]}}, token=token)
        present = []
    members = sorted(set(declared) | set(present)) if adopting else declared
    if members:
        call("PUT", "/v1/group/%s/_attr/member" % group, members, token=token)
    elif present:
        call("DELETE", "/v1/group/%s/_attr/member" % group, token=token)
had = observe(token)
merging = adopting and had is not None
redirects = sorted(set(want["redirects"]) | set(had["redirects"])) if merging else want["redirects"]
attrs = {
    "displayname": [want["displayName"]],
    "oauth2_rs_origin_landing": [want["landing"]],
    "oauth2_rs_origin": redirects,
}
if want.get("shortUsername") is not None:
    attrs[SHORT] = ["true" if want["shortUsername"] else "false"]
if not want["pkce"]:
    attrs[PKCE] = ["true"]
if had is None:
    attrs["name"] = [want["id"]]
    call("POST", "/v1/oauth2/_basic", {"attrs": attrs}, token=token)
else:
    call("PATCH", "/v1/oauth2/" + want["id"], {"attrs": attrs}, token=token)
for group, scopes in want["scopeMap"].items():
    if merging:
        scopes = sorted(set(scopes) | set(had["scopeMap"].get(group, [])))
    call("POST", "/v1/oauth2/%s/_scopemap/%s" % (want["id"], group), scopes, token=token)
if not merging:
    for group in (had or {}).get("scopeMap", {}):
        if group not in want["scopeMap"]:
            call("DELETE", "/v1/oauth2/%s/_scopemap/%s" % (want["id"], group), token=token)
    if want["pkce"] and had is not None and not had["pkce"]:
        call("DELETE", "/v1/oauth2/%s/_attr/%s" % (want["id"], PKCE), token=token)
print(json.dumps({"state": observe(token), "secret": secret(token)}))
`;

/** The client goes; the groups it brought stay, since a person may be in them for another. */
const REMOVE = `
serving()
token = login()
call("DELETE", "/v1/oauth2/" + P["client"]["id"], token=token, missing=True)
print(json.dumps({}))
`;

/** The admin password, read for the length of one call and never an input. */
async function adminPassword(props: KanidmClientInputs): Promise<string> {
  const value = await readField(props.vault, props.admin.item, props.admin.field);
  if (value === "") {
    throw new Error(
      `${props.admin.item}/${props.admin.field} is empty or unreadable — the identity ` +
        "provider's admin resource recovers it on the first deploy of its board",
    );
  }
  return value;
}

/** One program on the board, its JSON answer back. The password rides on stdin. */
async function speak<T>(
  props: KanidmClientInputs,
  operation: string,
  body: string,
  adopting = false,
): Promise<T> {
  const { Buffer } = await import("node:buffer");
  const payload = Buffer.from(
    JSON.stringify({
      port: props.port,
      attempts: HEALTH_ATTEMPTS,
      pause: HEALTH_PAUSE_SECONDS,
      account: props.admin.account,
      password: await adminPassword(props),
      client: {
        id: props.clientId,
        displayName: props.displayName,
        landing: props.landing,
        redirects: [...props.redirects].sort(),
        scopeMap: props.scopeMap,
        groups: props.groups,
        pkce: props.pkce,
        ...(props.shortUsername === undefined ? {} : { shortUsername: props.shortUsername }),
      },
      adopting,
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
    // The program's own sentence. Never its stdout, which can hold a secret.
    throw new Error(
      `the identity provider could not ${operation} '${props.clientId}': ` +
        `${result.stderr.trim() || "(no output)"}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    // Not the parser's message: it quotes the text it choked on, which can hold
    // the secret.
    throw new Error(`the identity provider's board answered '${props.clientId}' with no JSON`);
  }
}

async function digest(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The same URL however it is written: the server stores a bare origin as
 * `https://host/`, which the catalog writes `https://host`.
 */
function url(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

/** Sorted throughout, so an order the server or the catalog happens to use is not a diff. */
function normalised(props: KanidmClientInputs | Observed): string {
  const sortValues = (map: Record<string, readonly string[]>) =>
    Object.keys(map)
      .sort()
      .map((key) => [key, [...map[key]].sort()]);
  return JSON.stringify([
    props.displayName,
    url(props.landing),
    props.redirects.map(url).sort(),
    sortValues(props.scopeMap),
    sortValues(props.groups),
    props.pkce,
    props.shortUsername ?? null,
  ]);
}

/** Where a client is, and who registers it: a change here is the same client asked again. */
function address(props: KanidmClientInputs): string {
  return JSON.stringify([
    props.host,
    props.sshArgs ?? [],
    props.port,
    props.vault,
    props.admin,
    props.secret,
  ]);
}

/**
 * Apply, then hand the secret to the vault when it is not what the vault holds,
 * and read it back: an edit of an item is a read-modify-write, and one lost to
 * a concurrent edit would be a client whose secret is nowhere.
 *
 * The outputs are the state the server was left in rather than the inputs, so
 * what an adoption kept is a diff the next plan shows.
 */
async function apply(inputs: KanidmClientInputs, adopting: boolean): Promise<ClientOuts> {
  const answer = await speak<{ state: Observed; secret: string }>(
    inputs,
    "register",
    APPLY,
    adopting,
  );
  const { vault, secret } = inputs;
  if ((await readField(vault, secret.item, secret.field)) !== answer.secret) {
    await writeField(vault, secret.item, secret.field, answer.secret);
    if ((await readField(vault, secret.item, secret.field)) !== answer.secret) {
      throw new Error(`${secret.item}/${secret.field} does not hold what was written to it`);
    }
  }
  return { ...inputs, ...answer.state, secretHash: await digest(answer.secret) };
}

export const clientProvider: pulumi.dynamic.ResourceProvider<KanidmClientInputs, ClientOuts> = {
  async create(inputs) {
    return { id: inputs.clientId, outs: await apply(inputs, true) };
  },

  async read(id, props) {
    if (!props) return { id: undefined };
    const found = await speak<{ state: Observed | null; secretHash: string }>(
      props,
      "look up",
      LOOK,
    );
    if (found.state === null) return { id: undefined };
    // A secret reset on the server, or a vault field edited by hand, is a client
    // that is not the one this declared: absent, so the next `up` adopts it and
    // writes the secret that is current. An unreachable vault is neither, and
    // dropping a live client from state for it would be a refresh that lies.
    const held = await readField(props.vault, props.secret.item, props.secret.field);
    if (held === "" && !(await fieldMissing(props.vault, props.secret.item, props.secret.field))) {
      throw new Error(`${props.secret.item}/${props.secret.field} could not be read`);
    }
    if ((await digest(held)) !== found.secretHash) return { id: undefined };
    return { id, props: { ...props, ...found.state, secretHash: found.secretHash } };
  },

  async check(_olds, news) {
    const failures: pulumi.dynamic.CheckFailure[] = [];
    const name = /^[a-z][a-z0-9_-]*$/;
    if (!name.test(news.clientId)) {
      failures.push({ property: "clientId", reason: `'${news.clientId}' is no client id` });
    }
    for (const url of [news.landing, ...news.redirects]) {
      if (!url.startsWith("https://")) {
        failures.push({ property: "redirects", reason: `${url} is not an https URL` });
      }
    }
    if (news.redirects.length === 0) {
      failures.push({ property: "redirects", reason: "a client with no redirect signs no one in" });
    }
    if (Object.keys(news.scopeMap).length === 0) {
      failures.push({ property: "scopeMap", reason: "a client nobody may use signs no one in" });
    }
    for (const [group, scopes] of Object.entries(news.scopeMap)) {
      if (!name.test(group)) {
        failures.push({ property: "scopeMap", reason: `'${group}' is no group name` });
      }
      // The provider refuses an OIDC flow whose scopes leave this out.
      if (!scopes.includes("openid")) {
        failures.push({ property: "scopeMap", reason: `${group}'s scopes leave out openid` });
      }
    }
    for (const [group, members] of Object.entries(news.groups)) {
      if (!name.test(group)) {
        failures.push({ property: "groups", reason: `'${group}' is no group name` });
      }
      for (const person of members) {
        if (!name.test(person)) {
          failures.push({ property: "groups", reason: `'${person}' is no person name` });
        }
      }
    }
    return { inputs: news, failures };
  },

  async diff(_id, olds, news) {
    const replaces = olds.clientId === news.clientId ? [] : ["clientId"];
    const changes = normalised(olds) !== normalised(news) || address(olds) !== address(news);
    return { changes: changes || replaces.length > 0, replaces, deleteBeforeReplace: false };
  },

  async update(_id, _olds, news) {
    return { outs: await apply(news, false) };
  },

  async delete(_id, props) {
    await speak(props, "remove", REMOVE);
  },
};

/**
 * The admin account's password in the vault, recovered on the server when the
 * vault has none.
 *
 * `readField` answers "" for a missing field and for a vault it could not
 * reach, and the second must not reset a password, so absence is asked again
 * with `op item get`, whose answer for a missing field is definite.
 */
async function ensureAdmin(inputs: KanidmAdminInputs): Promise<void> {
  if ((await readField(inputs.vault, inputs.item, inputs.field)) !== "") return;
  if (!(await fieldMissing(inputs.vault, inputs.item, inputs.field))) {
    throw new Error(
      `${inputs.item}/${inputs.field} could not be read — the vault is unreachable, or the ` +
        "field is there and empty (delete it to have the account recovered); recovering it " +
        "now would reset a password that may be held",
    );
  }
  // The container can be between a restart and running, which `podman exec`
  // answers with an error rather than a wait.
  let result = await run(
    inputs.host,
    ["podman", "exec", inputs.container, ...inputs.recover],
    undefined,
    inputs.sshArgs,
  );
  for (let attempt = 1; attempt < RECOVER_ATTEMPTS && result.status !== 0; attempt++) {
    await new Promise((wake) => setTimeout(wake, RECOVER_PAUSE_MS));
    result = await run(
      inputs.host,
      ["podman", "exec", inputs.container, ...inputs.recover],
      undefined,
      inputs.sshArgs,
    );
  }
  const line = result.stdout
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text.startsWith("{"));
  let answer: { status?: string; output?: unknown } = {};
  try {
    answer = line === undefined ? {} : (JSON.parse(line) as typeof answer);
  } catch {
    answer = {};
  }
  if (result.status !== 0 || answer.status !== "ok" || typeof answer.output !== "string") {
    // The status and stderr only: stdout is where a password would be.
    throw new Error(
      `recovering the account in ${inputs.container} failed (exit ${result.status}): ` +
        `${result.stderr.trim() || "no JSON answer"}`,
    );
  }
  // A write that fails here loses the password the server just set — which costs
  // nothing but a run: the next one finds the field missing and recovers again.
  await writeField(inputs.vault, inputs.item, inputs.field, answer.output);
}

export const adminProvider: pulumi.dynamic.ResourceProvider<KanidmAdminInputs, KanidmAdminInputs> =
  {
    async create(inputs) {
      await ensureAdmin(inputs);
      return { id: `${inputs.container}-${inputs.field}`, outs: inputs };
    },

    async read(id, props) {
      if (!props) return { id: undefined };
      // Gone from the vault is absent here, so the next `up` recovers it.
      const held = await readField(props.vault, props.item, props.field);
      return held === "" ? { id: undefined } : { id, props };
    },

    async diff(_id, olds, news) {
      const keys = ["host", "container", "vault", "item", "field"] as const;
      const changes =
        keys.some((key) => olds[key] !== news[key]) ||
        JSON.stringify(olds.recover) !== JSON.stringify(news.recover) ||
        JSON.stringify(olds.sshArgs ?? []) !== JSON.stringify(news.sshArgs ?? []);
      return { changes };
    },

    async update(_id, _olds, news) {
      await ensureAdmin(news);
      return { outs: news };
    },

    async delete() {
      // Nothing: the account and its password outlive the stack.
    },
  };

export class KanidmAdmin extends pulumi.dynamic.Resource {
  constructor(name: string, args: Args<KanidmAdminInputs>, opts?: pulumi.CustomResourceOptions) {
    super(adminProvider, name, args, opts);
  }
}

export class KanidmClient extends pulumi.dynamic.Resource {
  declare public readonly secretHash: pulumi.Output<string>;

  constructor(name: string, args: Args<KanidmClientInputs>, opts?: pulumi.CustomResourceOptions) {
    super(clientProvider, name, { ...args, secretHash: undefined }, opts);
  }
}
