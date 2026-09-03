/**
 * Render the image's file tree to disk for the build.
 *
 *   yarn render [--out <dir>]
 *
 * The only impure step in the render path: everything above it is a pure
 * function from config to a `Tree`, which is what the invariant tests exercise.
 */

import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import { renderAll } from "../render";

const args = process.argv.slice(2);

let outDir = "build/root";
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--out") {
    const value = args[i + 1];
    if (value === undefined) {
      console.error("usage: yarn render [--out <dir>]");
      process.exit(2);
    }
    outDir = value;
    i += 1;
    continue;
  }
  console.error(
    `unexpected argument '${arg}' — one image serves every host, so the render ` +
      "takes no host name. A board's identity comes from keel.conf on its ESP.",
  );
  process.exit(2);
}

const { tree } = renderAll();

await rm(outDir, { recursive: true, force: true });

for (const [path, entry] of tree) {
  const target = join(outDir, path);
  await mkdir(dirname(target), { recursive: true });
  if (entry.symlinkTo !== undefined) {
    await symlink(entry.symlinkTo, target);
    continue;
  }
  await writeFile(target, entry.content, "utf8");
  await chmod(target, entry.mode);
}

console.log(`${tree.size} files -> ${outDir}`);
