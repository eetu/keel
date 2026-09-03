/**
 * Encrypting a secret for one host.
 *
 * Called from inside the `SealedEnv` provider, so the native imports are inside
 * the function body — the rule `ssh.ts` documents. What must never happen here
 * is a plaintext becoming a value a closure *captures*: serialisation would
 * write it to state (pulumi/pulumi#8265). It stays an argument and a local.
 */

type Sealed = {
  /** age ciphertext, safe to carry in state. */
  ciphertext: string;
  /** sha256 of the plaintext — the only thing a diff compares. */
  plaintextHash: string;
};

/** sha256 of a string, hex. */
export async function hash(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Encrypts for a single recipient, the public half of the identity that lives on
 * the target host.
 *
 * The plaintext hash is returned alongside because age is not deterministic:
 * without it, every deploy would look like a rotation. See `secretFile.ts`.
 */
export async function seal(plaintext: string, recipient: string): Promise<Sealed> {
  if (!recipient.startsWith("age1")) {
    throw new Error(`not an age recipient: ${recipient}`);
  }
  const { spawn } = await import("node:child_process");

  // Spawned rather than exec'd, because the plaintext goes in on stdin: passing a
  // secret as an argument would put it in the process table for anyone to read.
  const ciphertext = await new Promise<string>((resolve, reject) => {
    const child = spawn("age", ["--armor", "--recipient", recipient], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) resolve(out);
      else reject(new Error(`age exited ${code ?? "unknown"}: ${err.trim()}`));
    });
    child.stdin.end(plaintext);
  });

  return { ciphertext, plaintextHash: await hash(plaintext) };
}
