/**
 * Bring a board up when its mesh coordinator cannot answer.
 *
 *   yarn bootstrap -s <host>
 *
 * Every other deploy is `yarn deploy`. This one exists for the single state the
 * ordinary path cannot leave: the coordinator is down, and the resources that
 * describe *its* API are planned by asking it. `src/infra/netbird.ts` resolves
 * the built-in `All` group with a provider invoke, invokes fire while the
 * program is being evaluated, and an invoke that fails takes the preview with
 * it — so nothing is applied, including the quadlet that would start the
 * coordinator. A rebuilt board, a restored host, a coordinator someone stopped:
 * all of them land there, and the way out was a hand-edited source file and a
 * list of URNs typed from a state dump.
 *
 * Two things make that safe, and this script is here because doing one without
 * the other is worse than the failure:
 *
 *  - `KEEL_SKIP_MESH=1` stops the program declaring the mesh's API state.
 *  - `--exclude` on every resource that state holds, so Pulumi reads "not
 *    declared" as "not this run" rather than as "delete it". Without this the
 *    run would tear down the groups, keys, routes and nameservers of a live
 *    mesh — and a NetBird group that is deleted and recreated gives every peer
 *    that has ever joined a subject the coordinator has never seen.
 *
 * The exclusions are read out of the stack's own state rather than written
 * down, because a list in a file is a list that goes stale the first time
 * `netbird.ts` declares something new — and the failure of a stale list is the
 * deletion above.
 *
 * Everything else about the deploy is unchanged: same wrapper, same vault
 * warming, same arguments. Run `yarn deploy` afterwards — once the coordinator
 * answers, the mesh's own state is declared again and converges in one run.
 */

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { dotenv, repo } from "./dotenv";

const argv = process.argv.slice(2);

const stackAt = argv.findIndex((arg) => arg === "-s" || arg === "--stack");
const stack = stackAt === -1 ? undefined : argv[stackAt + 1];
if (stack === undefined || stack.startsWith("-")) {
  console.error("usage: yarn bootstrap -s <host> [pulumi up arguments...]");
  process.exit(2);
}

const pulumiBin = fileURLToPath(new URL("node_modules/.bin/pulumi", repo));
const cwd = fileURLToPath(repo);
// The state export only needs the passphrase, so it goes straight to the CLI —
// `scripts/pulumi.ts` would warm the vault and read the Cloudflare token first,
// which is a Touch ID prompt to answer a question about a local file.
const env = { ...dotenv(), ...process.env };

const exported = spawnSync(pulumiBin, ["stack", "export", "-s", stack], {
  cwd,
  env,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
if (exported.status !== 0) {
  console.error(`could not export stack '${stack}': ${exported.stderr.trim()}`);
  process.exit(exported.status ?? 1);
}

/**
 * Everything the bridged provider owns, and the provider itself — which has to
 * be excluded too, since deleting a provider whose resources are still in state
 * is an error the engine raises rather than a tidy-up.
 */
const MESH = /::netbird:index\/|::pulumi:providers:netbird::/;

/**
 * The resources whose `read` is a call to a service rather than a look at a
 * file: the coordinator's account and connector, and the metrics hub's account.
 * Each waits out a timeout and then fails, and a refresh that fails takes the
 * run with it — so on the board these exist for, which is one that is not
 * running them yet, they are the thing that stops the refresh.
 *
 * Matched by the suffix the program names them with rather than by type: they
 * are ordinary dynamic resources and nothing in state tells them apart from a
 * file. Over-matching costs a resource its refresh for one run, which the `up`
 * that follows converges anyway; under-matching costs the whole run.
 */
const DIALS_A_SERVICE = /-(account|connector)$/;

let resources: string[];
try {
  const state = JSON.parse(exported.stdout) as {
    deployment?: { resources?: { urn?: string }[] };
  };
  resources = (state.deployment?.resources ?? [])
    .map((resource) => resource.urn)
    .filter((urn): urn is string => urn !== undefined);
} catch (error) {
  console.error(`could not read stack '${stack}': ${(error as Error).message}`);
  process.exit(1);
}

const mesh = resources.filter((urn) => MESH.test(urn));
const unreachable = resources.filter((urn) => DIALS_A_SERVICE.test(urn));

// A stack with nothing of the mesh in it is a first deploy, where the program
// declares the resources for the first time and there is nothing to protect
// from deletion. Saying so beats a silent run that looks like the other case.
console.error(
  mesh.length === 0
    ? `no mesh resources in '${stack}' yet — nothing to exclude`
    : `excluding ${mesh.length} mesh resources from this run`,
);

const wrapper = fileURLToPath(new URL("scripts/pulumi.ts", repo));
const exclude = (urns: readonly string[]): string[] => urns.flatMap((urn) => ["--exclude", urn]);

const phase = (args: readonly string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", wrapper, ...args], {
      cwd,
      stdio: "inherit",
      env: { ...env, KEEL_SKIP_MESH: "1" },
    });
    child.on("error", reject);
    // A signal is not an exit code; reporting one as 0 would let a killed deploy
    // look like a clean one to whatever ran this.
    child.on("exit", (code, signal) => resolve(signal === null ? (code ?? 1) : 1));
  });

/**
 * Two phases, and the split is the whole of why this is a script.
 *
 * A rebuilt board needs the refresh: state describes files that are no longer
 * on the disk, and without a read saying so, `up` compares inputs that have not
 * changed and writes nothing — a deploy that reports success onto an empty
 * machine. But the refresh is also what cannot run, because three of the reads
 * are calls to services the board is not running yet.
 *
 * So: refresh everything that can answer, then update from what that learned.
 * `up` without `--refresh` is right here precisely because the phase before it
 * already did one.
 */
const refresh = await phase(["refresh", ...argv, ...exclude([...mesh, ...unreachable])]);
if (refresh !== 0) process.exit(refresh);
process.exit(await phase(["up", ...argv, ...exclude(mesh)]));
