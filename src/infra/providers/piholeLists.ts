/**
 * A Pi-hole's subscribed lists, converged to the exact set its entry declares.
 *
 * The lists live in Pi-hole's own gravity database, which is service state: a
 * restored backup carries whatever it held, a board built from configuration
 * alone has none of it, and a list added in the web UI is visible to no review.
 * So the deploy owns them the way it owns a hub account — through the API, from
 * the board, on the service's loopback port.
 *
 * Adding a list to the database blocks nothing by itself: the domains reach the
 * resolver only when gravity is rebuilt. Neither Terraform provider for Pi-hole
 * v6 does that step, which is the difference between a list that is subscribed
 * and one that works. This does it whenever the set changed, and only then — a
 * rebuild downloads every list and takes minutes on a small board.
 *
 * A list is keyed by address *and* type: the same URL can be a blocklist and an
 * allow list at once, and the API addresses each by `?type=`. The address sits
 * in the path, so it is sent percent-encoded.
 *
 * `read` asks the API what is subscribed, so a list added or removed in the UI
 * is drift on a refresh and the next deploy puts the set back. `delete` removes
 * nothing: dropping the declaration hands the lists back to whoever edits them,
 * and a retired Pi-hole takes its database with it anyway.
 *
 * The API is expected to answer without a password, on loopback — the entry's
 * web UI is behind the edge gate. A 401 fails by name rather than guessing at
 * credentials.
 */

import * as pulumi from "@pulumi/pulumi";

import { run } from "../ssh";
import type { Args } from "./inputs";

export type PiholeListsInputs = {
  host: string;
  sshArgs?: readonly string[];
  /** `http://127.0.0.1:<port><api>` — the service's own API, on loopback. */
  api: string;
  /** Every blocklist subscribed to. */
  block: readonly string[];
};

type Outs = PiholeListsInputs & {
  /** What the API holds and enables, as sorted `<type> <address>` keys. */
  held: readonly string[];
};

const ATTEMPTS = 30;
const PAUSE_SECONDS = 2;

/** The declared set, in the form `held` is read back in. */
export function wanted(block: readonly string[]): readonly string[] {
  return [...new Set(block)].map((address) => `block ${address}`).sort();
}

/**
 * The part every program starts with. Composed line by line rather than as an
 * indented block, because a first line indented differently from the rest is a
 * syntax error in Python.
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
    sys.stderr.write(what + "\\n")
    raise SystemExit(1)


def call(path, method="GET", body=None, timeout=30):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        P["api"] + path, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            raw = answer.read()
    except urllib.error.HTTPError as error:
        if error.code == 401:
            fail("the API wants a password; lists are managed on loopback with none")
        fail("%s %s answered HTTP %d" % (method, path.split("?")[0], error.code))
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {}


def held():
    seen = "no answer"
    for attempt in range(P["attempts"]):
        if attempt:
            time.sleep(P["pause"])
        try:
            lists = call("/lists").get("lists", [])
            return {(l["type"], l["address"]): l for l in lists}
        except SystemExit:
            raise
        except Exception as error:
            seen = type(error).__name__
    fail("not answering after %ds (%s)" % (P["attempts"] * P["pause"], seen))


def keys(lists):
    return sorted("%s %s" % key for key, entry in lists.items() if entry.get("enabled", True))
`;

const CONVERGE = `
now = held()
want = {("block", address) for address in P["block"]}
changed = False
for (kind, address), entry in now.items():
    path = "/lists/%s?type=%s" % (urllib.parse.quote(address, safe=""), kind)
    if (kind, address) not in want:
        call(path, "DELETE")
        changed = True
    elif not entry.get("enabled", True):
        call(path, "PUT", {"enabled": True, "comment": entry.get("comment") or "keel", "groups": entry.get("groups") or [0]})
        changed = True
for kind, address in sorted(want - set(now)):
    call("/lists?type=%s" % kind, "POST", {"address": address, "enabled": True, "comment": "keel", "groups": [0]})
    changed = True
if changed:
    # Streams its progress while it downloads every list; the timeout bounds a
    # stalled read, not the whole rebuild.
    call("/action/gravity", "POST", timeout=600)
print(json.dumps(keys(held())))
`;

const READ = `
print(json.dumps(keys(held())))
`;

async function speak(props: PiholeListsInputs, operation: string, body: string): Promise<string[]> {
  const { Buffer } = await import("node:buffer");
  const payload = Buffer.from(
    JSON.stringify({
      api: props.api,
      block: props.block,
      attempts: ATTEMPTS,
      pause: PAUSE_SECONDS,
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
    throw new Error(
      `Pi-hole at ${props.api} could not ${operation}: ${result.stderr.trim() || "(no output)"}`,
    );
  }
  return JSON.parse(result.stdout) as string[];
}

const provider: pulumi.dynamic.ResourceProvider<PiholeListsInputs, Outs> = {
  async create(inputs) {
    const held = await speak(inputs, "converge its lists", CONVERGE);
    return { id: `${inputs.host}:${inputs.api}`, outs: { ...inputs, held } };
  },

  async read(id, props) {
    if (props === undefined) return { id };
    // A Pi-hole that is not answering yet says nothing about its lists, so the
    // refresh keeps what it knew rather than reporting every list gone.
    try {
      return { id, props: { ...props, held: await speak(props, "list its lists", READ) } };
    } catch {
      return { id, props };
    }
  },

  async diff(_id, olds, news) {
    const replaces = olds.host !== news.host ? ["host"] : [];
    const drifted =
      olds.api !== news.api || JSON.stringify(olds.held) !== JSON.stringify(wanted(news.block));
    return { changes: replaces.length > 0 || drifted, replaces, deleteBeforeReplace: false };
  },

  async update(_id, _olds, news) {
    return { outs: { ...news, held: await speak(news, "converge its lists", CONVERGE) } };
  },

  async delete() {},
};

/** The provider, so what `diff` calls drift is an assertion rather than prose. */
export const piholeListsProvider = provider;

export class PiholeLists extends pulumi.dynamic.Resource {
  declare public readonly held: pulumi.Output<string[]>;

  constructor(name: string, args: Args<PiholeListsInputs>, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, { held: undefined, ...args }, opts);
  }
}
