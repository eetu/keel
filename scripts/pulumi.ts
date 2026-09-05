/**
 * Runs the vendored `pulumi` CLI with the two values the deploy needs in its
 * environment before Pulumi starts evaluating the program.
 *
 *   yarn preview -s <host>    # pulumi preview --refresh --parallel 4
 *   yarn deploy  -s <host>    # pulumi up      --refresh --parallel 4
 *
 * Neither value may be typed into a committed script. `PULUMI_CONFIG_PASSPHRASE`
 * is one line of the gitignored `.env`, and the Cloudflare API token lives in the
 * 1Password vault whose *name* is a field of the gitignored
 * `src/config/installation.ts` — so the vault is imported here rather than
 * spelled, the same way every other reader of it works.
 *
 * `@pulumi/cloudflare` configures itself from `CLOUDFLARE_API_TOKEN` while the
 * program is being evaluated, which is `up` and `preview` alike. That is the
 * whole reason this wrapper exists, and the reason a preview of this stack has
 * to run from a terminal 1Password can prompt.
 *
 * The token is a string in this process and one entry in the child's
 * environment. It is never an argument, never written to a file, and never
 * printed: the failure it can have names the item and the field, never the
 * value.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { INSTALLATION } from "../src/config/installation";
import { readField } from "../src/infra/vault";

/**
 * The `cloudflare` item is a login whose password field is the API token — the
 * same field the proxy's DNS-01 challenge reads, so one item serves both.
 */
const CLOUDFLARE_ITEM = "cloudflare";
const CLOUDFLARE_FIELD = "password";

const repo = new URL("..", import.meta.url);

/**
 * `.env` as a map. Values already in the process environment win, which is what
 * lets one shell override the file for a single run.
 */
function dotenv(path: URL): Record<string, string> {
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

// One `op` call before Pulumi starts anything. Pulumi fans its resources out and
// runs their vault reads concurrently, so several would race the first Touch ID
// prompt and the losers hear only "authorization prompt dismissed" — which is
// indistinguishable from a field that does not exist. Warming the session means
// the prompt is answered once, in front of the person who ran the command.
const warm = spawnSync("op", ["vault", "list"], { stdio: ["inherit", "ignore", "inherit"] });
if (warm.status !== 0) {
  console.error("op could not open a session — run this from a terminal 1Password can prompt");
  process.exit(warm.status ?? 1);
}

const token = await readField(INSTALLATION.vault, CLOUDFLARE_ITEM, CLOUDFLARE_FIELD);
if (token === "") {
  console.error(`${CLOUDFLARE_ITEM}/${CLOUDFLARE_FIELD} is empty or unreadable`);
  process.exit(1);
}

const child = spawn(
  fileURLToPath(new URL("node_modules/.bin/pulumi", repo)),
  process.argv.slice(2),
  {
    cwd: fileURLToPath(repo),
    stdio: "inherit",
    env: { ...dotenv(new URL(".env", repo)), ...process.env, CLOUDFLARE_API_TOKEN: token },
  },
);

child.on("error", (error) => {
  console.error(`could not run the vendored pulumi: ${error.message}`);
  process.exit(1);
});
// A signal is not an exit code; reporting one as 0 would let a killed deploy
// look like a clean one to whatever ran this.
child.on("exit", (code, signal) => process.exit(signal === null ? (code ?? 1) : 1));
