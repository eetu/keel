/**
 * The digest a moving tag currently points at, as a Pulumi resource.
 *
 * The resolution is a registry round-trip, and a round-trip in the program body
 * would fire on every `pulumi preview` — the thing a preview is not allowed to
 * do. Inside a resource it happens on `create`, on `update` and on `read`, which
 * is to say on `up` and on `refresh`, and never on a bare preview.
 *
 * `read` re-resolves, so a tag that has moved shows up as drift under
 * `pulumi refresh` or `preview --refresh`. That is also the only thing that
 * moves it: a bare `up` re-uses the digest in state, because the inputs — the
 * tag — have not changed. Picking up a new build is therefore `pulumi up
 * --refresh`, the same command that picks up a rotated secret.
 *
 * Only a rolling tag needs this. A spec already pinned by digest creates no
 * resource at all: the call site passes the reference straight through, and
 * `check` here refuses one, so the short-circuit cannot be forgotten quietly.
 *
 * `../registry` is safe to import at module scope because `resolveDigest`
 * imports its own native dependencies inside the function body — the rule
 * `ssh.ts` documents.
 */

import * as pulumi from "@pulumi/pulumi";

import { resolveDigest } from "../registry";

export type ImageDigestInputs = {
  /** A tag reference, e.g. `ghcr.io/owner/app:main`. */
  ref: string;
};

type Outs = ImageDigestInputs & {
  /** `repo@sha256:…`, what the quadlet actually runs. */
  digestRef: string;
};

const provider: pulumi.dynamic.ResourceProvider<ImageDigestInputs, Outs> = {
  async create(inputs) {
    return { id: inputs.ref, outs: { ...inputs, digestRef: await resolveDigest(inputs.ref) } };
  },

  async read(id, props) {
    // `props` is absent on `pulumi import`, where the id — the reference — is
    // all there is. A registry that cannot be reached raises rather than
    // returning the stored digest: "the tag has not moved" is a claim this
    // cannot make without asking.
    const ref = props?.ref ?? id;
    return { id, props: { ref, digestRef: await resolveDigest(ref) } };
  },

  async check(_olds, news) {
    const failures: pulumi.dynamic.CheckFailure[] = [];
    if (news.ref.includes("@sha256:")) {
      failures.push({
        property: "ref",
        reason: `${news.ref} is already digest-pinned — a pinned service resolves nothing`,
      });
    } else if (!/:[\w.-]+$/.test(news.ref)) {
      failures.push({ property: "ref", reason: `${news.ref} names no tag` });
    }
    return { inputs: news, failures };
  },

  async diff(_id, olds, news) {
    // Inputs only, which is the whole tag/digest split: the digest lives in the
    // outputs, so it moves when a refresh reads a new one and not when the plan
    // is drawn from state.
    return { changes: olds.ref !== news.ref };
  },

  async update(id, _olds, news) {
    return { outs: { ...news, digestRef: await resolveDigest(news.ref) } };
  },

  // No `delete`: a tag lookup owns nothing on a registry or a device, so
  // dropping the resource is dropping a cached answer.
};

export class ImageDigest extends pulumi.dynamic.Resource {
  declare public readonly digestRef: pulumi.Output<string>;

  constructor(name: string, args: ImageDigestInputs, opts?: pulumi.CustomResourceOptions) {
    super(provider, name, { ...args, digestRef: undefined }, opts);
  }
}
