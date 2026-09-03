/**
 * A service's environment, read from the vault and sealed for one host.
 *
 * Reading the vault is a Touch ID prompt and sealing is a subprocess; in the
 * program body both would fire on every `pulumi preview`. Inside a resource they
 * fire on `create`, `update` and `read` — so on `up` and on `refresh`, and never
 * on a bare preview. **A prompt during a deploy is expected; a prompt during a
 * preview is a bug.**
 *
 * `read` re-reads the vault, re-hashes and re-seals, so a credential rotated in
 * 1Password surfaces as drift under `pulumi refresh` or `preview --refresh` and
 * cascades from there: the hash is a `SecretFile` input and part of the unit's
 * restart trigger, so the blob is rewritten, decrypted and the service restarted
 * in the same run. Rotating a secret is `pulumi up --refresh` — a bare `up`
 * compares inputs, and the vault is not one of them.
 *
 * What is *not* here is the plaintext. It is an argument and a local inside the
 * methods, never an input, never an output and never captured: a captured secret
 * is serialised into state in plaintext (pulumi/pulumi#8265). The outputs are
 * ciphertext the state cannot open and a hash of what it holds.
 */

import * as pulumi from "@pulumi/pulumi";

import { hash, seal } from "../age";
import { readEnvFile } from "../vault";

export type SealedEnvInputs = {
  /** The 1Password vault the item lives in. */
  vault: string;
  /** The item holding the fields. */
  item: string;
  /** Environment variable name -> vault field name. Names only; no values. */
  fields: Record<string, string>;
  /**
   * Variables whose field is on another item: variable name -> item. Left out
   * entirely when every field is on `item`, which is the usual case — an absent
   * key and an empty map have to look the same to a diff, or every service in
   * the fleet would re-seal the first time one of them needed this.
   */
  fieldItems?: Record<string, string>;
  /**
   * Public half of the age identity on the target host. Not a secret: it only
   * lets you encrypt *to* the host.
   */
  ageRecipient: string;
};

type Outs = SealedEnvInputs & {
  /** age ciphertext. Safe in state; the identity that opens it is on the host. */
  ciphertext: string;
  /** sha256 of the plaintext. What a rotation is detected by. */
  plaintextHash: string;
};

/** Stable regardless of how the map was written, so a re-ordering is not a diff. */
const fingerprint = (fields: Record<string, string> = {}): string =>
  Object.keys(fields)
    .sort()
    .map((name) => `${name}=${fields[name]}`)
    .join("\n");

const provider: pulumi.dynamic.ResourceProvider<SealedEnvInputs, Outs> = {
  async create(inputs) {
    const sealed = await seal(
      await readEnvFile(inputs.vault, inputs.item, inputs.fields, inputs.fieldItems),
      inputs.ageRecipient,
    );
    return { id: `${inputs.vault}/${inputs.item}`, outs: { ...inputs, ...sealed } };
  },

  async read(id, props) {
    // Nothing to re-derive from on `pulumi import`: the id names the item but
    // not the fields it was built from, and inventing a field set would seal
    // the wrong thing.
    if (!props) return { id: undefined };
    const plaintext = await readEnvFile(props.vault, props.item, props.fields, props.fieldItems);
    const plaintextHash = await hash(plaintext);
    // Re-sealing an unchanged secret would produce different bytes for the same
    // value — age is not deterministic — so the ciphertext is only replaced when
    // the plaintext behind it actually moved.
    if (plaintextHash === props.plaintextHash) return { id, props };
    return { id, props: { ...props, ...(await seal(plaintext, props.ageRecipient)) } };
  },

  async check(_olds, news) {
    const failures: pulumi.dynamic.CheckFailure[] = [];
    if (!news.ageRecipient.startsWith("age1")) {
      failures.push({ property: "ageRecipient", reason: "not an age recipient" });
    }
    for (const [name, field] of Object.entries(news.fields)) {
      // A value here rather than a field name would be a plaintext secret on
      // its way into state.
      if (!/^[a-z][a-z0-9_.@-]*$/.test(field)) {
        failures.push({ property: "fields", reason: `${name} names no vault field: '${field}'` });
      }
    }
    for (const [name, item] of Object.entries(news.fieldItems ?? {})) {
      if (!(name in news.fields)) {
        failures.push({ property: "fieldItems", reason: `${name} is not one of the fields` });
      }
      if (!/^[a-z][a-z0-9_.-]*$/.test(item)) {
        failures.push({ property: "fieldItems", reason: `${name} names no vault item: '${item}'` });
      }
    }
    return { inputs: news, failures };
  },

  async diff(_id, olds, news) {
    // Inputs only: the vault's contents are outputs, and asking the vault what
    // they are is `read`'s job, not a diff's — that is what keeps the prompt off
    // a bare preview.
    return {
      changes:
        olds.vault !== news.vault ||
        olds.item !== news.item ||
        olds.ageRecipient !== news.ageRecipient ||
        fingerprint(olds.fields) !== fingerprint(news.fields) ||
        fingerprint(olds.fieldItems) !== fingerprint(news.fieldItems),
    };
  },

  async update(id, _olds, news) {
    const sealed = await seal(
      await readEnvFile(news.vault, news.item, news.fields, news.fieldItems),
      news.ageRecipient,
    );
    return { outs: { ...news, ...sealed } };
  },

  // No `delete`: this resource owns nothing outside the vault, and the vault is
  // the source of truth a deploy reads rather than a place a deploy writes. The
  // blob on the device belongs to `SecretFile`, whose delete removes it.
};

export class SealedEnv extends pulumi.dynamic.Resource {
  declare public readonly ciphertext: pulumi.Output<string>;
  declare public readonly plaintextHash: pulumi.Output<string>;

  constructor(name: string, args: SealedEnvInputs, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, { ...args, ciphertext: undefined, plaintextHash: undefined }, opts);
  }
}
