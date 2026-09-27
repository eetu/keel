/**
 * Renovate for what Renovate cannot see: the digest pins in the gitignored
 * catalog, which never reach the repository CI runs on.
 *
 *   yarn update           # list what is behind, ask before each bump
 *   yarn update --check   # list only
 *
 * A bump rewrites the pin as `repo:tag@digest` — the index digest, as
 * `scripts/pin-image.sh` resolves it — so a pin that carried no tag gains one,
 * and the next run needs no search to know what it is. A new image is a new
 * quadlet body, so every bump restarts its service on each board that runs it;
 * that list is printed, and the local golden is re-taken to match.
 */

import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { INSTALLATION } from "../src/config/installation";
import { SERVICES } from "../src/config/services";
import { hostServices } from "../src/config/spec";
import { repo } from "./dotenv";
import { findPins, newerTag, type Pin, releasesNewestFirst } from "./imageTags";

const FILES = ["src/config/services.local.ts", "src/config/installation.ts"];
/** How many recent releases a tag-less pin's digest is compared against. */
const SEARCH = 20;
/** Registry calls in flight per pin. */
const BATCH = 8;

const run = promisify(execFile);

// --no-creds: a stale stored login is refused harder than anonymity, the reason
// pin-image.sh and registry.ts give.
const skopeo = async (verb: string, args: string[]): Promise<string | undefined> => {
  try {
    const { stdout } = await run("skopeo", [verb, "--no-creds", ...args], {
      maxBuffer: 64 << 20,
    });
    return stdout;
  } catch {
    return undefined;
  }
};

const ARM64 = ["--override-os", "linux", "--override-arch", "arm64"];

const tagsOf = async (image: string): Promise<string[]> =>
  (
    JSON.parse((await skopeo("list-tags", [`docker://${image}`])) ?? '{"Tags":[]}') as {
      Tags: string[];
    }
  ).Tags;

/** The index digest, which is what a new pin is written with. */
const digestOf = async (image: string, tag: string): Promise<string | undefined> =>
  (
    await skopeo("inspect", [...ARM64, "--format", "{{.Digest}}", `docker://${image}:${tag}`])
  )?.trim();

/** The version label the pinned image carries, which is only ever a hint. */
const labelOf = async (pin: Pin): Promise<string | undefined> =>
  (
    await skopeo("inspect", [
      ...ARM64,
      "--format",
      '{{index .Labels "org.opencontainers.image.version"}}',
      `docker://${pin.repo}@${pin.digest}`,
    ])
  )?.trim();

/**
 * Whether `tag` is the pinned image. A pin may hold the tag's index digest or
 * one architecture's manifest — older pins took the instance from `podman pull`
 * — so both count: the raw manifest's own hash, and every manifest it lists.
 */
const pinnedAs = async (pin: Pin, tag: string): Promise<boolean> => {
  const raw = await skopeo("inspect", ["--raw", `docker://${pin.repo}:${tag}`]);
  if (raw === undefined) return false;
  if (`sha256:${createHash("sha256").update(raw).digest("hex")}` === pin.digest) return true;
  const { manifests = [] } = JSON.parse(raw) as { manifests?: { digest: string }[] };
  return manifests.some((entry) => entry.digest === pin.digest);
};

/** The label's tag first, then recent releases, each batch checked at once. */
async function versionOf(pin: Pin, tags: readonly string[]): Promise<string | undefined> {
  const label = await labelOf(pin);
  const hinted = label ? [label, `v${label}`, label.replace(/^v/, "")] : [];
  const order = [...new Set([...hinted, ...releasesNewestFirst(tags).slice(0, SEARCH)])].filter(
    (tag) => tags.includes(tag),
  );
  for (let i = 0; i < order.length; i += BATCH) {
    const batch = order.slice(i, i + BATCH);
    const hits = await Promise.all(batch.map((tag) => pinnedAs(pin, tag)));
    const found = batch.find((_, index) => hits[index]);
    if (found !== undefined) return found;
  }
  return undefined;
}

type Bump = { pin: Pin; file: string; from: string; to: string; digest: string };

async function plan(pin: Pin, file: string): Promise<Bump | string> {
  const tags = await tagsOf(pin.repo);
  if (tags.length === 0) return "no tags listed";
  const current = pin.tag ?? (await versionOf(pin, tags));
  if (current === undefined) return `digest matches none of the last ${SEARCH} releases`;
  const next = newerTag(tags, current);
  if (next === undefined) return `${current}, up to date`;
  const digest = await digestOf(pin.repo, next);
  if (digest === undefined) return `${current}, ${next} does not resolve for arm64`;
  return { pin, file, from: current, to: next, digest };
}

/** Which service each board would restart, named from the catalog itself. */
function restarts(refs: ReadonlySet<string>): string[] {
  const moved = SERVICES.filter((spec) => refs.has(spec.image));
  return Object.entries(INSTALLATION.hosts).flatMap(([host, board]) => {
    const names = hostServices(board, moved).map((spec) => spec.name);
    return names.length === 0 ? [] : [`${host}: ${names.join(", ")}`];
  });
}

const pins = FILES.flatMap((file) =>
  findPins(readFileSync(new URL(file, repo), "utf8")).map((pin) => ({ pin, file })),
);
const results = await Promise.all(pins.map(({ pin, file }) => plan(pin, file)));
const bumps: Bump[] = [];
results.forEach((result, index) => {
  const { pin } = pins[index]!;
  if (typeof result === "string") console.log(`  ${pin.repo}: ${result}`);
  else {
    console.log(`↑ ${pin.repo}: ${result.from} -> ${result.to}`);
    bumps.push(result);
  }
});

if (bumps.length === 0 || process.argv.includes("--check") || !process.stdin.isTTY) {
  process.exit(0);
}

const ask = createInterface({ input: process.stdin, output: process.stdout });
const chosen: Bump[] = [];
for (const bump of bumps) {
  const answer = await ask.question(`bump ${bump.pin.repo} to ${bump.to}? [y/N] `);
  if (answer.trim().toLowerCase() === "y") chosen.push(bump);
}
ask.close();
if (chosen.length === 0) process.exit(0);

for (const bump of chosen) {
  const path = new URL(bump.file, repo);
  const next = `${bump.pin.repo}:${bump.to}@${bump.digest}`;
  writeFileSync(path, readFileSync(path, "utf8").replaceAll(`"${bump.pin.ref}"`, `"${next}"`));
}

console.log("\nrestarts on the next deploy:");
for (const line of restarts(new Set(chosen.map((bump) => bump.pin.ref)))) console.log(`  ${line}`);

// The pin's tag is part of the golden body, its digest is masked; either way
// the snapshot is re-taken here rather than failing the next validate.
// The vendored release by path: under `yarn update`, npm_execpath is a shell
// shim node cannot run.
const { packageManager } = JSON.parse(readFileSync(new URL("package.json", repo), "utf8")) as {
  packageManager: string;
};
const yarn = fileURLToPath(
  new URL(`.yarn/releases/yarn-${packageManager.replace(/^yarn@/, "")}.cjs`, repo),
);
const golden = spawnSync(
  process.execPath,
  [yarn, "vitest", "run", "-u", "tests/golden.local.test.ts"],
  { cwd: fileURLToPath(repo), stdio: ["ignore", "ignore", "inherit"] },
);
console.log(golden.status === 0 ? "local golden re-taken" : "local golden failed — run yarn test");
