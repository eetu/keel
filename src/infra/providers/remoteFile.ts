/**
 * A file on a device, as a Pulumi resource that can be read back.
 *
 * This is the piece `@pulumi/command` cannot provide: `remote.Command`
 * implements no `read` at all, so a refresh has nothing to ask and drift is
 * undetectable however it is invoked. Here `read` returns the file's actual
 * content and mode, so `pulumi refresh` — or `preview --refresh` — sees a
 * hand-edited file. A bare `preview` still compares against stored state.
 *
 * Content is a resource input and therefore persisted in state, which is exactly
 * why secrets reach a device as age ciphertext: the state holds the blob, the
 * device holds the identity, and no plaintext exists on either side. `/etc/secrets`
 * is refused here outright — that is `SecretFile`'s directory, and a plain file
 * written into it would be a plaintext secret in state. Note also that a dynamic
 * provider must never *capture* a secret — serialisation would write it to state
 * in plaintext (pulumi/pulumi#8265).
 */

import * as pulumi from "@pulumi/pulumi";

import { assertSafePath, run, runOk } from "../ssh";
import { type Args } from "./inputs";

export type RemoteFileInputs = {
  /** ssh_config alias. */
  host: string;
  path: string;
  content: string;
  /** Octal string, as `install -m` wants it. */
  mode: string;
  /** Extra ssh arguments — an alternate config file, a jump host, a port. */
  sshArgs?: readonly string[];
};

type Outs = RemoteFileInputs & { id: string };

/** Where sealed blobs live, and the one directory this resource may not write. */
const SECRETS_DIR = "/etc/secrets/";

/**
 * Shell-safe, and not a secret's home. The second half is the structural form of
 * "no plaintext in state": a `RemoteFile` carries its content as an input, so a
 * `RemoteFile` under /etc/secrets would put a secret there by construction. Age
 * ciphertext goes through `SecretFile` instead.
 */
export function assertWritablePath(path: string): void {
  assertSafePath(path);
  if (path.startsWith(SECRETS_DIR)) {
    throw new Error(
      `${path} is under ${SECRETS_DIR} — its content would be state in plaintext; use SecretFile`,
    );
  }
}

const write = async (inputs: RemoteFileInputs): Promise<void> => {
  assertWritablePath(inputs.path);
  await runOk(
    inputs.host,
    ["install", "-D", "-m", inputs.mode, "/dev/stdin", inputs.path],
    inputs.content,
    inputs.sshArgs,
  );
};

const provider: pulumi.dynamic.ResourceProvider<RemoteFileInputs, Outs> = {
  async create(inputs) {
    await write(inputs);
    const id = `${inputs.host}:${inputs.path}`;
    return { id, outs: { ...inputs, id } };
  },

  async read(id, props) {
    // `props` is absent on `pulumi import`, where the id is all there is. It is
    // `<host>:<path>`, and a path cannot contain a colon (assertSafePath).
    const host = props?.host ?? id.slice(0, id.indexOf(":"));
    const path = props?.path ?? id.slice(id.indexOf(":") + 1);
    const sshArgs = props?.sshArgs;
    assertWritablePath(path);
    const mode = await run(host, ["stat", "-c", "%a", path], undefined, sshArgs);
    if (mode.status !== 0) return { id: undefined };
    const content = await runOk(host, ["cat", path], undefined, sshArgs);
    // sshArgs joins only when set: the plugin encodes these props as a protobuf
    // Struct, and Struct has no encoding for a key holding `undefined` — the
    // refresh dies with "Unexpected struct type" before the value is even seen.
    return {
      id,
      props: {
        id,
        host,
        path,
        content,
        mode: mode.stdout.trim(),
        ...(sshArgs === undefined ? {} : { sshArgs }),
      },
    };
  },

  async check(_olds, news) {
    // Rejecting here rather than in `create` means a bad path fails the plan
    // instead of failing halfway through an apply.
    const failures: pulumi.dynamic.CheckFailure[] = [];
    try {
      assertWritablePath(news.path);
    } catch (error) {
      failures.push({ property: "path", reason: (error as Error).message });
    }
    if (!/^[0-7]{3,4}$/.test(news.mode)) {
      failures.push({ property: "mode", reason: `mode must be octal, got '${news.mode}'` });
    }
    return { inputs: news, failures };
  },

  async diff(_id, olds, news) {
    const replaces = [
      ...(olds.path !== news.path ? ["path"] : []),
      ...(olds.host !== news.host ? ["host"] : []),
    ];
    return {
      changes: olds.content !== news.content || olds.mode !== news.mode || replaces.length > 0,
      replaces,
      deleteBeforeReplace: true,
    };
  },

  async update(id, _olds, news) {
    await write(news);
    return { outs: { ...news, id } };
  },

  async delete(_id, props) {
    assertWritablePath(props.path);
    await runOk(props.host, ["rm", "-f", props.path], undefined, props.sshArgs);
  },
};

export class RemoteFile extends pulumi.dynamic.Resource {
  declare public readonly content: pulumi.Output<string>;

  constructor(name: string, args: Args<RemoteFileInputs>, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, { ...args, id: undefined }, opts);
  }
}
