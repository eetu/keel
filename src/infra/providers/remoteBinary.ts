/**
 * A binary the deploy needs from `/usr`, as a resource that fails the deploy
 * before the part depending on it runs.
 *
 * Almost nothing Pulumi applies here cares which image a board booted, and the
 * two halves of keel are deployable in either order. A mount helper is the
 * exception, and it is the dangerous kind of exception: `credentials=` is
 * `mount.cifs`'s option, not the kernel's, and util-linux without the helper
 * mounts through the kernel directly — which parses the option list itself and
 * ignores the one it does not implement. So the mount does not fail on the
 * missing credential. It fails at authentication (`SMB signature verification
 * returned error = -13`) against a server that demands one, and *succeeds
 * unauthenticated* against a server that allows guests. The credential mechanism
 * is silently absent rather than loudly missing, which is precisely the shape a
 * deploy must never have.
 *
 * Hence a probe with a name and an error message, ordered before the unit that
 * would otherwise discover it. It reads the machine on `create` and on `read`,
 * so `pulumi up` and `pulumi refresh` both ask; a bare `up` over unchanged
 * inputs does not, the same as every other resource here.
 *
 * Deliberately not a greenboot check. The selftest runs on the image that just
 * booted, and the image that just booted is the one that has the helper — the
 * question is whether the *host's current* image does, which only something
 * running at deploy time can ask.
 */

import * as pulumi from "@pulumi/pulumi";

import { assertSafePath, run } from "../ssh";
import { type Args } from "./inputs";

export type RemoteBinaryInputs = {
  /** ssh_config alias. */
  host: string;
  /** Absolute path of the binary, as whatever needs it looks it up. */
  path: string;
  /** The image package that installs it, named in the error. */
  installedBy: string;
  /** What stops working without it, named in the error. */
  neededBy: string;
  /** Extra ssh arguments — an alternate config file, a jump host, a port. */
  sshArgs?: readonly string[];
};

type Outs = RemoteBinaryInputs;

const probe = async (inputs: RemoteBinaryInputs): Promise<boolean> => {
  assertSafePath(inputs.path);
  const result = await run(inputs.host, ["test", "-x", inputs.path], undefined, inputs.sshArgs);
  return result.status === 0;
};

const provider: pulumi.dynamic.ResourceProvider<RemoteBinaryInputs, Outs> = {
  async create(inputs) {
    if (!(await probe(inputs))) {
      throw new Error(
        `${inputs.host} has no ${inputs.path}: ${inputs.neededBy} needs it, ${inputs.installedBy} ` +
          "installs it, and that is image content rather than anything a deploy can place — " +
          "update the host to an image carrying it and reboot, then deploy again. Without it a " +
          "CIFS mount does not report the missing credential: the kernel ignores credentials= " +
          "and the share mounts unauthenticated wherever the server permits it",
      );
    }
    return { id: `${inputs.host}:${inputs.path}`, outs: inputs };
  },

  async read(id, props) {
    // `props` is absent on `pulumi import`, where the id — `<host>:<path>` — is
    // all there is, and a path cannot contain a colon (assertSafePath).
    const known: RemoteBinaryInputs = props ?? {
      host: id.slice(0, id.indexOf(":")),
      path: id.slice(id.indexOf(":") + 1),
      installedBy: "an image package",
      neededBy: "a deployed resource",
    };
    // Gone rather than drifted: a rollback to an image without the helper leaves
    // nothing to reconcile, and the next `up` re-creates the resource — which is
    // the probe, failing by name before it hands the mount to systemd.
    if (!(await probe(known))) return { id: undefined };
    return { id, props: known };
  },

  async check(_olds, news) {
    const failures: pulumi.dynamic.CheckFailure[] = [];
    try {
      assertSafePath(news.path);
    } catch (error) {
      failures.push({ property: "path", reason: (error as Error).message });
    }
    return { inputs: news, failures };
  },

  async diff(_id, olds, news) {
    const replaces = [
      ...(olds.path !== news.path ? ["path"] : []),
      ...(olds.host !== news.host ? ["host"] : []),
    ];
    return { changes: replaces.length > 0, replaces, deleteBeforeReplace: true };
  },

  async update(id, _olds, news) {
    // Unreachable while `diff` replaces on both inputs; the probe is here so
    // that widening `diff` later cannot quietly stop asking the machine.
    if (!(await probe(news))) throw new Error(`${news.host} has no ${news.path}`);
    return { outs: news };
  },

  // No `delete`: this owns nothing on the device. It is a question that was
  // asked, and dropping it drops the answer.
};

export class RemoteBinary extends pulumi.dynamic.Resource {
  constructor(name: string, args: Args<RemoteBinaryInputs>, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, args, opts);
  }
}
