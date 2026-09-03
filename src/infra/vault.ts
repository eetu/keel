/**
 * Reading secrets out of 1Password.
 *
 * The single place a plaintext secret exists in this repo's execution, and it
 * exists only in memory: the caller seals it for the target host immediately and
 * what leaves is ciphertext. Nothing writes a plaintext to disk, to state, or to
 * a log.
 *
 * Called from inside the `SealedEnv` provider, which is why every native import
 * is inside a function body and why this module holds no state at all: a
 * module-scope value a provider closure captures is serialised into state, and
 * a `Map` or a builtin is exactly what the serialiser cannot turn into a
 * `require` call. See `ssh.ts`.
 *
 * Uses the `op` CLI's desktop-app integration, so there is no session token to
 * manage: the first call prompts for Touch ID and is cached for a while after.
 * Fields are read one at a time and in order, so a cold keychain asks once and
 * the rest of the item follows — concurrent reads would race the same prompt.
 */

/** A single field of an item. Returns "" when absent, so optional paths stay branch-free. */
export async function readField(vault: string, item: string, field: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  try {
    const { stdout } = await exec("op", ["read", `op://${vault}/${item}/${field}`]);
    return stdout.replace(/\n$/, "");
  } catch {
    return "";
  }
}

/**
 * The decrypted file is read by podman — the quadlet's `EnvironmentFile=`
 * becomes `podman run --env-file` — and podman's parser is the docker one:
 * no quote stripping, no escapes, the bytes after `=` up to the newline ARE
 * the value. A quoted value therefore deploys with literal quotes around it
 * (an AES key that is suddenly two bytes too long, a password no login
 * accepts). So the line is raw, and the characters raw cannot carry are
 * refused here, at deploy time, where the error can name the field.
 */
export function envLine(name: string, value: string): string {
  if (/[\n\r]/.test(value)) {
    throw new Error(`${name}: a value with a newline cannot ride an env file`);
  }
  return `${name}=${value}`;
}

/**
 * Builds an `EnvironmentFile` body from a map of variable name to vault field.
 *
 * Sorted by variable name, which matters more than it looks: the body's hash is
 * what decides whether a secret has rotated, so an ordering that depended on how
 * the map was written would turn a harmless edit into a rewrite and a restart.
 *
 * `itemOverrides` names the variables whose field lives on a different item from
 * the service's own. That is the shape of a generated credential: an OIDC client
 * secret is issued by the identity provider and stored with its credentials, so
 * the client's env file is assembled from two items.
 */
export async function readEnvFile(
  vault: string,
  item: string,
  mapping: Record<string, string>,
  itemOverrides: Record<string, string> = {},
): Promise<string> {
  const lines: string[] = [];
  // One field per read, and one read at a time: `op` prompts, and a prompt is
  // not something to ask for four times at once.
  const seen = new Map<string, string>();
  for (const name of Object.keys(mapping).sort()) {
    const field = mapping[name];
    const from = itemOverrides[name] ?? item;
    const key = `${from}/${field}`;
    const cached = seen.get(key);
    const value = cached ?? (await readField(vault, from, field));
    seen.set(key, value);
    // Loudly, because the failure mode is silent and bad: `readField` returns
    // "" for a missing field *and* for an unreachable vault, and a service that
    // declared a credential would then deploy with none — an admin API that
    // asks for nothing looks exactly like one that works.
    if (value === "") {
      throw new Error(`${key} is empty or unreadable — ${name} would be deployed blank`);
    }
    lines.push(envLine(name, value));
  }
  return `${lines.join("\n")}\n`;
}
