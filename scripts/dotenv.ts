/**
 * `.env` as a map, shared by the two scripts that spawn the Pulumi CLI.
 *
 * Its own module because `scripts/pulumi.ts` does its work at import time — it
 * warms the 1Password session and reads the Cloudflare token as a side effect of
 * being loaded, which is right for a wrapper that is only ever executed and
 * wrong for anything that wants one function out of it.
 */

import { readFileSync } from "node:fs";

export const repo = new URL("..", import.meta.url);

/**
 * Values already in the process environment win, which is what lets one shell
 * override the file for a single run.
 */
export function dotenv(path: URL = new URL(".env", repo)): Record<string, string> {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    // A machine that exports the passphrase some other way has no file here,
    // and Pulumi says what is missing better than a guess would.
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    // A quoted value is unquoted the way dotenv does it — the passphrase is
    // pasted from the vault, and a pair of quotes around it is not part of it.
    values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}
