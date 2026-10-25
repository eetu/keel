/**
 * A lock on the deploy machine, for resources that must take turns at
 * something outside it — writing fields of one vault item, writing to a server
 * that serves one write at a time.
 *
 * A directory in the temporary directory, held while `run` does: `mkdir` either
 * makes it or finds it, atomically, whichever process asks. One older than any
 * holder takes is a run that died holding it, and is taken over.
 *
 * Imports nothing at module scope, for the reason `ssh.ts` gives: this is called
 * from inside dynamic providers.
 */
export async function locked<T>(name: string, run: () => Promise<T>): Promise<T> {
  const { mkdir, rmdir, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = `${tmpdir()}/keel-${name.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`;
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      const since = await stat(path).then(
        (found) => Date.now() - found.mtimeMs,
        () => 0,
      );
      if (since > 300_000) await rmdir(path).catch(() => undefined);
      else await new Promise((wake) => setTimeout(wake, 250));
    }
  }
  try {
    return await run();
  } finally {
    await rmdir(path).catch(() => undefined);
  }
}
