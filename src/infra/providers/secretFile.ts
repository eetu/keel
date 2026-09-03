/**
 * An age-encrypted secret on a device.
 *
 * The plaintext never becomes a resource input, so it never reaches the state
 * file: what Pulumi carries is ciphertext the state cannot open, because the
 * identity lives only on the host. That is also why a dynamic provider must never
 * *capture* a secret — serialisation writes captured values to state in plaintext
 * (pulumi/pulumi#8265).
 *
 * The awkward part is that age is not deterministic: encrypting the same
 * plaintext twice gives different bytes. Diffing on ciphertext would therefore
 * report a change on every run and restart the service every deploy. So the
 * semantic input is a hash of the plaintext, and the ciphertext rides along
 * without being compared — except when a refresh has found the remote copy
 * altered, which is what `remoteSha` is for:
 *
 *   changed  =  the plaintext hash moved                       (a real rotation)
 *            |  the remote file no longer matches what we wrote (drift)
 *
 * The rule that matters for a provider module is narrower than "import
 * nothing": what may not happen is a value a closure *captures* transitively
 * reaching a native/builtin binding at module scope, since Pulumi's serialiser
 * cannot turn that into a `require` call and walks into node internals instead
 * (see `ssh.ts`). `@pulumi/pulumi` and `../ssh` are safe to import here because
 * the helpers this module actually calls — `run`, `runOk`, `assertSafePath` —
 * import their own native dependencies lazily, inside the function body.
 */

import * as pulumi from "@pulumi/pulumi";

import { assertSafePath, run, runOk } from "../ssh";
import { type Args } from "./inputs";

export type SecretFileInputs = {
  /** ssh_config alias. */
  host: string;
  /** Where the blob lands. `keel-secrets.service` decrypts it to the same name minus `.age`. */
  path: string;
  /** age ciphertext. Safe in state; the identity that opens it is not here. */
  ciphertext: string;
  /** sha256 of the plaintext. The only thing a diff is allowed to compare. */
  plaintextHash: string;
  sshArgs?: readonly string[];
};

type Outs = SecretFileInputs & { remoteSha: string };

const sha256 = async (text: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
};

/**
 * An empty blob decrypts to nothing and the service boots with a blank
 * environment — and an unknown that slips through dependency resolution
 * arrives here as exactly that empty string. Refusing is always right: there
 * is no legitimate empty secret.
 */
export function assertCiphertext(ciphertext: string | undefined, path: string): void {
  if (ciphertext === undefined || ciphertext === "") {
    throw new Error(`refusing to write empty ciphertext to ${path}`);
  }
}

const write = async (inputs: SecretFileInputs): Promise<void> => {
  assertSafePath(inputs.path);
  assertCiphertext(inputs.ciphertext, inputs.path);
  // 0600: the decrypted sibling is read by root only, and the blob deserves the
  // same treatment even though it is useless without the identity.
  await runOk(
    inputs.host,
    ["install", "-D", "-m", "600", "/dev/stdin", inputs.path],
    inputs.ciphertext,
    inputs.sshArgs,
  );
  // And open it now: `keel-secrets.service` only runs at boot, so a service first
  // given a credential would otherwise wait for a reboot to read it.
  await runOk(inputs.host, ["/usr/lib/keel/decrypt-secrets"], undefined, inputs.sshArgs);
};

/** sha256 of the file as it exists on the device, or "" when absent. */
const remoteSha = async (inputs: SecretFileInputs): Promise<string> => {
  const result = await run(inputs.host, ["sha256sum", inputs.path], undefined, inputs.sshArgs);
  if (result.status !== 0) return "";
  return result.stdout.trim().split(/\s+/)[0] ?? "";
};

const provider: pulumi.dynamic.ResourceProvider<SecretFileInputs, Outs> = {
  async create(inputs) {
    await write(inputs);
    return {
      id: `${inputs.host}:${inputs.path}`,
      outs: { ...inputs, remoteSha: await sha256(inputs.ciphertext) },
    };
  },

  async read(id, props) {
    if (!props) return { id: undefined };
    assertSafePath(props.path);
    const found = await remoteSha(props);
    if (found === "") return { id: undefined };
    // The plaintext hash and ciphertext are carried through unchanged: this
    // provider cannot decrypt, and does not need to. A `remoteSha` that no longer
    // matches the ciphertext we wrote is enough to know the file was altered.
    return { id, props: { ...props, remoteSha: found } };
  },

  async diff(_id, olds, news) {
    const replaces = olds.path !== news.path || olds.host !== news.host ? ["path"] : [];
    const rotated = olds.plaintextHash !== news.plaintextHash;
    const drifted = olds.remoteSha !== (await sha256(olds.ciphertext));
    return {
      changes: rotated || drifted || replaces.length > 0,
      replaces,
      deleteBeforeReplace: true,
    };
  },

  async update(id, _olds, news) {
    await write(news);
    return { outs: { ...news, remoteSha: await sha256(news.ciphertext) } };
  },

  async delete(_id, props) {
    assertSafePath(props.path);
    // The decrypted sibling goes too, or a retired service leaves its secret
    // readable on disk.
    await run(
      props.host,
      ["rm", "-f", props.path, props.path.replace(/\.age$/, "")],
      undefined,
      props.sshArgs,
    );
  },
};

export class SecretFile extends pulumi.dynamic.Resource {
  constructor(name: string, args: Args<SecretFileInputs>, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, { ...args, remoteSha: undefined }, opts);
  }
}
