/**
 * Resolving a moving tag to the digest it currently points at.
 *
 * A tag like `main` is invisible to Pulumi: the string does not change when the
 * tag moves, so nothing diffs, nothing restarts, and the new build never runs.
 * Resolving restores the property that makes a rolling tag worth having — the
 * plan shows a digest changing, the restart follows from that change, and the
 * previous digest is still in state to roll back to.
 *
 * Called from inside the `ImageDigest` provider, so this module imports nothing
 * at module scope: a provider's methods are serialised into state, and a
 * captured builtin is what Pulumi's serialiser cannot turn into a `require`
 * call. See `ssh.ts` for the whole rule.
 */

/**
 * Returns `repo@sha256:…` for a tag reference, or the reference unchanged if it
 * is already digest-pinned.
 *
 * Uses `skopeo` when present, because it reads the manifest without downloading
 * the image. Falls back to podman, which has to pull first — cached, so the cost
 * is paid once per new build rather than per run.
 *
 * Both resolve the manifest *list*, not one architecture's manifest, so the
 * digest is valid on the machine running the deploy and on the board.
 */
export async function resolveDigest(ref: string): Promise<string> {
  if (ref.includes("@sha256:")) return ref;

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  const repo = ref.slice(0, ref.lastIndexOf(":"));

  const skopeo = async (creds: boolean) => {
    const { stdout } = await exec("skopeo", [
      "inspect",
      // Stored registry credentials outlive their revocation, and a registry
      // rejects a stale login harder than it rejects anonymity — a public
      // image then resolves with --no-creds and 403s without it.
      ...(creds ? [] : ["--no-creds"]),
      // The deploy may run on a machine that is neither the board's
      // architecture nor its OS; without these skopeo resolves the list against
      // the local platform and fails on an image that has no instance for it.
      "--override-os",
      "linux",
      "--override-arch",
      "arm64",
      "--format",
      "{{.Digest}}",
      `docker://${ref}`,
    ]);
    return `${repo}@${stdout.trim()}`;
  };

  try {
    return await skopeo(true).catch(() => skopeo(false));
  } catch {
    // skopeo absent or the registry refused it; podman knows the digest once it
    // holds the image.
    await exec("podman", ["pull", "--quiet", "--arch", "arm64", ref]);
    const { stdout } = await exec("podman", [
      "image",
      "inspect",
      ref,
      "--format",
      "{{index .RepoDigests 0}}",
    ]);
    const digest = stdout.trim();
    if (!digest.includes("@sha256:")) {
      throw new Error(`could not resolve a digest for ${ref}, got '${digest}'`);
    }
    return digest;
  }
}
