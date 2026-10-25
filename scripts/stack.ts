/**
 * The environment every script runs the vendored Pulumi CLI in, and the run.
 *
 * The stack passphrase is the one value every command needs. It is taken from
 * the process environment, then `.env`, then the vault — the `keel` item's
 * password, in the vault `src/config/installation.ts` names — so a machine with
 * a clone and a 1Password login has everything a deploy needs, and `.env` is an
 * override rather than a file each machine has to be handed.
 *
 * Its own module because `scripts/pulumi.ts` does its work at import time, and
 * `scripts/cli.ts` and `scripts/bootstrap.ts` want the passphrase without the
 * Cloudflare token that wrapper reads.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { INSTALLATION } from "../src/config/installation";
import { readField } from "../src/infra/vault";
import { dotenv, repo } from "./dotenv";

/** Committed for the reason the Cloudflare item's names are: a stranger creates the same one. */
const PASSPHRASE_ITEM = "keel";
const PASSPHRASE_FIELD = "password";

export type Env = Record<string, string | undefined>;

/**
 * Exits naming the item and the field when the vault has no passphrase, rather
 * than letting Pulumi stop at an interactive prompt nobody is watching.
 */
export async function pulumiEnv(): Promise<Env> {
  const env: Env = { ...dotenv(), ...process.env };
  // `.env.example` ships the line empty, and an empty line means "not stated".
  if ((env.PULUMI_CONFIG_PASSPHRASE ?? "") !== "") return env;
  const passphrase = await readField(INSTALLATION.vault, PASSPHRASE_ITEM, PASSPHRASE_FIELD);
  if (passphrase === "") {
    console.error(`${PASSPHRASE_ITEM}/${PASSPHRASE_FIELD} is empty or unreadable`);
    process.exit(1);
  }
  return { ...env, PULUMI_CONFIG_PASSPHRASE: passphrase };
}

/** Resolves to the CLI's exit status. */
export function runPulumi(args: readonly string[], env: Env): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(fileURLToPath(new URL("node_modules/.bin/pulumi", repo)), args, {
      cwd: fileURLToPath(repo),
      stdio: "inherit",
      env,
    });
    child.on("error", (error) => {
      console.error(`could not run the vendored pulumi: ${error.message}`);
      resolve(1);
    });
    // A signal is not an exit code; reporting one as 0 would let a killed
    // deploy look like a clean one to whatever ran this.
    child.on("exit", (code, signal) => resolve(signal === null ? (code ?? 1) : 1));
  });
}
