/**
 * Root command execution on a host, over its ssh_config alias.
 *
 * The alias rather than an address plus key: ssh_config already knows the user,
 * the port and which agent key to present, and keeping that out of Pulumi means
 * no private key material is ever an input to a resource.
 *
 * `sshArgs` covers what an alias cannot carry on its own — an alternate config
 * file, a jump host, an explicit port. It is a list of arguments, never a shell
 * string, so nothing here is re-parsed by a shell.
 *
 * **This module deliberately has no imports at module scope.** A dynamic
 * provider's methods are serialised into state, and Pulumi's serialiser only
 * turns a captured value into a `require` call when it can resolve the value
 * back to a module — `require('fs')` resolves, `require('fs').readFile` does
 * not, and an ESM named import looks exactly like the second case. It then walks
 * the function object into node internals and fails on native code. Pulling the
 * builtin in with `await import()` inside the function captures nothing, so
 * there is nothing to walk. See pulumi/pulumi#6987 and #18977.
 */

export type Result = {
  status: number;
  stdout: string;
  stderr: string;
};

/**
 * ssh joins its arguments and the remote shell re-parses them, so a path with
 * shell syntax in it would be executed rather than written. Every path here is a
 * literal from config, and this makes that an enforced property.
 */
export function assertSafePath(path: string): void {
  if (!/^\/[A-Za-z0-9._\-/@]*$/.test(path)) {
    throw new Error(`unsafe remote path: ${path}`);
  }
}

/**
 * The same property for a unit name, which reaches `systemctl` through the same
 * re-parsing remote shell. A unit name is `name.suffix` with an optional
 * instance part, and nothing else — no spaces, no globs, no shell syntax.
 *
 * A backslash is shell syntax too, which is why systemd's own path escaping does
 * not survive this: the remote shell eats it, so `var-mnt-my\x2dshare.mount`
 * arrives as `var-mnt-myx2dshare.mount` and `systemctl` acts on a unit nobody
 * wrote. Refusing it here means a name that cannot be transported cannot be
 * transported corrupted either; `assertShare` refuses the mountpoint that
 * produces one at plan time, where the error can say what to rename.
 */
export function assertSafeUnit(unit: string): void {
  if (!/^[A-Za-z0-9:._\-@]+\.(service|socket|timer|target|path|mount|slice)$/.test(unit)) {
    throw new Error(`unsafe unit name: ${unit}`);
  }
}

/**
 * A connection that died before the command ran. Pulumi runs many resources
 * concurrently and each one is its own ssh session, so a burst of them trips one
 * of sshd's two throttles: `MaxStartups` resets the excess connections during the
 * key exchange, and `MaxSessions` refuses the excess sessions a multiplexing
 * client opens over one connection (`mux_client_request_session: session request
 * failed: Session open refused by peer`). Both are congestion, not an error — the
 * retry below absorbs them. An authentication failure or a remote command failing
 * stays un-retried: repeating those only repeats the answer.
 */
const transient = (status: number, stderr: string): boolean =>
  status === 255 &&
  /kex_exchange_identification|Connection reset by peer|Connection closed by remote host|mux_client_request_session|Session open refused/.test(
    stderr,
  );

/**
 * ssh's own exit status, which is never the remote command's: ssh exits 255 when
 * it could not connect, authenticate or open the session, and otherwise with
 * whatever the command returned. So a 255 says nothing about the device, and a
 * caller reading "did the command fail" out of the status would read a refused
 * session as a missing file, a missing unit or a missing binary — which, on a
 * refresh, is a live resource dropped from state and re-created on the next
 * run. It is thrown instead, so a transport that gave out fails the operation
 * by name rather than answering a question it never asked.
 */
const TRANSPORT_FAILED = 255;

/**
 * Spawned rather than exec'd synchronously: Pulumi runs resources concurrently,
 * and a synchronous call would serialise every provider's work onto one blocked
 * event loop. `spawn` also lets content reach the remote command on stdin, which
 * is how file contents get there without a shell redirection.
 */
export async function run(
  host: string,
  argv: readonly string[],
  stdin?: string,
  sshArgs: readonly string[] = [],
): Promise<Result> {
  const { spawn } = await import("node:child_process");

  const attempt = (): Promise<Result> =>
    new Promise<Result>((resolve) => {
      const child = spawn("ssh", [...sshArgs, host, "sudo", ...argv], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (error: Error) => {
        resolve({ status: 1, stdout, stderr: error.message });
      });
      child.on("close", (code: number | null) => {
        resolve({ status: code ?? 1, stdout, stderr });
      });

      child.stdin.end(stdin ?? "");
    });

  let result = await attempt();
  for (let backoffMs = 500; transient(result.status, result.stderr); backoffMs *= 2) {
    if (backoffMs > 16000) break;
    await new Promise((wake) => setTimeout(wake, backoffMs));
    result = await attempt();
  }
  if (result.status === TRANSPORT_FAILED) {
    throw new Error(
      `ssh ${host} could not run ${argv[0] ?? "the command"}: ${result.stderr.trim() || "(no output)"}`,
    );
  }
  return result;
}

export async function runOk(
  host: string,
  argv: readonly string[],
  stdin?: string,
  sshArgs: readonly string[] = [],
): Promise<string> {
  const result = await run(host, argv, stdin, sshArgs);
  if (result.status !== 0) {
    // Both streams: systemctl says "Job for x.service failed" on stderr but puts
    // the reason on stdout, and an error carrying only half of that is a second
    // round-trip to the machine before anyone knows what happened.
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" / ");
    throw new Error(
      `ssh ${host} ${argv.join(" ")} failed (${result.status}): ${detail || "(no output)"}`,
    );
  }
  return result.stdout;
}
