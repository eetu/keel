/**
 * `yarn pulumi <args>`: the vendored CLI with the stack passphrase and nothing
 * else — no Cloudflare token, so a command that evaluates the program stops at
 * the zone lookup. `yarn preview` and `yarn deploy` are the ones that do.
 */

import process from "node:process";

import { pulumiEnv, runPulumi } from "./stack";

process.exit(await runPulumi(process.argv.slice(2), await pulumiEnv()));
