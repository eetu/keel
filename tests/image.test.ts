/**
 * The rendered tree, byte for byte.
 *
 * Every file the image carries is pinned here with its mode, so a change to any
 * of them is a diff somebody reads rather than a line a test happened to look
 * for. This is what lets the rest of the suite be short: a test earns its place
 * by stating a rule — why a file says what it says — and never by repeating a
 * line the renderer wrote, because this snapshot already holds that line.
 *
 * The tree is rendered from committed configuration alone, so the snapshot is the
 * same on the bench and in CI, and the same for anybody who clones the repository.
 * A diff here is a new image digest and a reboot on every board, which is what
 * makes it worth reading.
 */

import { describe, expect, it } from "vitest";

import { renderAll } from "../src/render";

const { tree } = renderAll();

describe.each([...tree.keys()].sort())("%s", (path) => {
  it("renders the same bytes", () => {
    const entry = tree.get(path)!;
    const head =
      entry.symlinkTo === undefined
        ? `mode ${entry.mode.toString(8)}`
        : `symlink -> ${entry.symlinkTo}`;
    expect(`${head}\n${entry.content}`).toMatchSnapshot();
  });
});
