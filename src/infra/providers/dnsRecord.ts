/**
 * A Cloudflare DNS A record, as a Pulumi resource with a real `read`.
 *
 * Not `@pulumi/cloudflare`: that provider configures itself at preview time,
 * from a token that has to sit in the process environment or in stack config —
 * a plaintext file on disk, or a value in state — for a `pulumi preview` that
 * today needs neither. This is a dynamic provider instead, the shape
 * `SealedEnv` already has: the token is read from the vault inside `create`,
 * `update`, `read` and `delete` — which run on `up` and on `refresh`, never on
 * a bare preview — and it is never an input, an output, or a value any closure
 * captures. It never leaves the function that reads it: not into an error
 * message, not into a log line.
 *
 * `../raspi/tasks/cloudflare_dns.py` populated this zone by hand before this
 * module existed, so `create` adopts rather than assumes an empty zone: it
 * looks up A records already answering the name, and exactly one match becomes
 * this resource — patched first if its content or ttl disagree with what the
 * catalog wants. None becomes a fresh record. More than one is not a decision
 * this makes silently; it fails by name and leaves the duplicate for a person.
 */

import * as pulumi from "@pulumi/pulumi";

import { readField } from "../vault";
import { type Args } from "./inputs";

/** The item and field the token lives at — a committed convention, not a house fact. */
export const CLOUDFLARE_VAULT_ITEM = "cloudflare";
export const CLOUDFLARE_TOKEN_FIELD = "token";

/** Cloudflare's code for "no such DNS record" — a 404 wearing a 200. */
const RECORD_GONE = 81044;

export type DnsRecordInputs = {
  /** The 1Password vault the `cloudflare` item lives in. */
  vault: string;
  /** The zone: the registered domain the record's name lives under. */
  domain: string;
  /** The record's fully-qualified name, e.g. `foo.example.com`. */
  name: string;
  /** What the A record points at — the LAN address every vhost resolves to. */
  content: string;
  ttl: number;
};

type Outs = DnsRecordInputs & {
  zoneId: string;
  recordId: string;
};

type CfError = { code: number; message: string };
type CfEnvelope<T> = { success: boolean; result: T; errors: CfError[] };
type CfZone = { id: string };
type CfDnsRecord = { id: string; content: string; ttl: number };

const describeErrors = (errors: readonly CfError[]): string =>
  errors.map((error) => `${error.code}: ${error.message}`).join("; ");

async function token(vault: string): Promise<string> {
  const value = await readField(vault, CLOUDFLARE_VAULT_ITEM, CLOUDFLARE_TOKEN_FIELD);
  if (value === "") {
    throw new Error(
      `${vault}/${CLOUDFLARE_VAULT_ITEM}/${CLOUDFLARE_TOKEN_FIELD} is empty or unreadable`,
    );
  }
  return value;
}

/** A call expected to succeed — the zone lookup and every write. */
async function cf<T>(bearer: string, path: string, method = "GET", body?: string): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body,
  });
  const envelope = (await response.json()) as CfEnvelope<T>;
  if (!envelope.success) {
    throw new Error(`Cloudflare API ${method} ${path} failed: ${describeErrors(envelope.errors)}`);
  }
  return envelope.result;
}

/** A read by id, where "gone" is a valid answer rather than a failure. */
async function cfFind<T>(bearer: string, path: string): Promise<T | undefined> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (response.status === 404) return undefined;
  const envelope = (await response.json()) as CfEnvelope<T>;
  if (!envelope.success) {
    if (envelope.errors.some((error) => error.code === RECORD_GONE)) return undefined;
    throw new Error(`Cloudflare API GET ${path} failed: ${describeErrors(envelope.errors)}`);
  }
  return envelope.result;
}

async function cfDelete(bearer: string, path: string): Promise<void> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (response.status === 404) return;
  const envelope = (await response.json()) as CfEnvelope<unknown>;
  if (!envelope.success && !envelope.errors.some((error) => error.code === RECORD_GONE)) {
    throw new Error(`Cloudflare API DELETE ${path} failed: ${describeErrors(envelope.errors)}`);
  }
}

async function zoneId(bearer: string, domain: string): Promise<string> {
  const zones = await cf<CfZone[]>(bearer, `/zones?name=${encodeURIComponent(domain)}`);
  const zone = zones[0];
  if (zone === undefined) {
    throw new Error(`no Cloudflare zone named ${domain} is readable with cloudflare/token`);
  }
  return zone.id;
}

async function recordsByName(
  bearer: string,
  zone: string,
  name: string,
): Promise<readonly CfDnsRecord[]> {
  return cf<CfDnsRecord[]>(
    bearer,
    `/zones/${zone}/dns_records?type=A&name=${encodeURIComponent(name)}`,
  );
}

const recordBody = (inputs: DnsRecordInputs): string =>
  JSON.stringify({
    type: "A",
    name: inputs.name,
    content: inputs.content,
    ttl: inputs.ttl,
    proxied: false,
    comment: "keel",
  });

/** What `create` does with what it found, decided without touching the network. */
export type Decision =
  | { action: "create" }
  | { action: "adopt"; id: string }
  | { action: "patch"; id: string }
  | { action: "ambiguous"; ids: readonly string[] };

/**
 * Exactly one A record already named this: adopt it, patched first if its
 * content or ttl disagree. None: create. More than one: a person decides,
 * because the old repository could have left duplicates behind.
 */
export function decide(
  existing: readonly { id: string; content: string; ttl: number }[],
  wanted: { content: string; ttl: number },
): Decision {
  if (existing.length === 0) return { action: "create" };
  if (existing.length > 1) {
    return { action: "ambiguous", ids: existing.map((record) => record.id) };
  }
  const [record] = existing;
  if (record.content === wanted.content && record.ttl === wanted.ttl) {
    return { action: "adopt", id: record.id };
  }
  return { action: "patch", id: record.id };
}

const provider: pulumi.dynamic.ResourceProvider<DnsRecordInputs, Outs> = {
  async create(inputs) {
    const bearer = await token(inputs.vault);
    const zone = await zoneId(bearer, inputs.domain);
    const existing = await recordsByName(bearer, zone, inputs.name);
    const decision = decide(existing, inputs);

    if (decision.action === "ambiguous") {
      throw new Error(
        `${decision.ids.length} A records already answer ${inputs.name}: ` +
          `${decision.ids.join(", ")} — a person decides which one this owns`,
      );
    }
    if (decision.action === "adopt") {
      return { id: decision.id, outs: { ...inputs, zoneId: zone, recordId: decision.id } };
    }
    if (decision.action === "patch") {
      await cf(bearer, `/zones/${zone}/dns_records/${decision.id}`, "PATCH", recordBody(inputs));
      return { id: decision.id, outs: { ...inputs, zoneId: zone, recordId: decision.id } };
    }
    const created = await cf<CfDnsRecord>(
      bearer,
      `/zones/${zone}/dns_records`,
      "POST",
      recordBody(inputs),
    );
    return { id: created.id, outs: { ...inputs, zoneId: zone, recordId: created.id } };
  },

  async read(id, props) {
    // Nothing to re-derive from on `pulumi import`: the id names the record but
    // not which zone or vault it belongs to.
    if (!props) return { id: undefined };
    const bearer = await token(props.vault);
    const record = await cfFind<CfDnsRecord>(
      bearer,
      `/zones/${props.zoneId}/dns_records/${props.recordId}`,
    );
    // Gone in the dashboard is gone here too — the next `up` recreates it.
    if (record === undefined) return { id: undefined };
    return { id, props: { ...props, content: record.content, ttl: record.ttl } };
  },

  async check(_olds, news) {
    const failures: pulumi.dynamic.CheckFailure[] = [];
    if (!news.name.endsWith(`.${news.domain}`)) {
      failures.push({ property: "name", reason: `${news.name} is not under ${news.domain}` });
    }
    if (!Number.isInteger(news.ttl) || news.ttl < 60) {
      failures.push({ property: "ttl", reason: `${news.ttl} is not a valid Cloudflare ttl` });
    }
    return { inputs: news, failures };
  },

  async diff(_id, olds, news) {
    if (olds.domain !== news.domain || olds.name !== news.name) {
      // A new name is a new record, not an edit of this one — Cloudflare has no
      // rename, so the old one is deleted and a fresh id adopted or created.
      return { changes: true, replaces: ["domain", "name"], deleteBeforeReplace: true };
    }
    return { changes: olds.content !== news.content || olds.ttl !== news.ttl };
  },

  async update(id, olds, news) {
    const bearer = await token(news.vault);
    await cf(
      bearer,
      `/zones/${olds.zoneId}/dns_records/${olds.recordId}`,
      "PATCH",
      recordBody(news),
    );
    return { outs: { ...news, zoneId: olds.zoneId, recordId: olds.recordId } };
  },

  async delete(_id, props) {
    const bearer = await token(props.vault);
    await cfDelete(bearer, `/zones/${props.zoneId}/dns_records/${props.recordId}`);
  },
};

export class DnsRecord extends pulumi.dynamic.Resource {
  declare public readonly zoneId: pulumi.Output<string>;
  declare public readonly recordId: pulumi.Output<string>;

  constructor(name: string, args: Args<DnsRecordInputs>, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, { ...args, zoneId: undefined, recordId: undefined }, opts);
  }
}
