import { describe, expect, it } from "vitest";

import { findPins, newerTag, releasesNewestFirst } from "../scripts/imageTags";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("yarn update", () => {
  it("finds digest pins, with or without a tag, and leaves branch tags alone", () => {
    const source = [
      `image: "docker.io/deluan/navidrome@${DIGEST}",`,
      `image: "docker.io/library/traefik:v3.7.12@${DIGEST}",`,
      `image: "ghcr.io/eetu/halo:main",`,
    ].join("\n");
    expect(findPins(source)).toEqual([
      {
        ref: `docker.io/deluan/navidrome@${DIGEST}`,
        repo: "docker.io/deluan/navidrome",
        digest: DIGEST,
      },
      {
        ref: `docker.io/library/traefik:v3.7.12@${DIGEST}`,
        repo: "docker.io/library/traefik",
        tag: "v3.7.12",
        digest: DIGEST,
      },
    ]);
  });

  it("moves within a tag's series, compared as numbers", () => {
    const tags = ["v0.9.9", "v0.10.0", "v0.11.0-rc1", "sha-ffe9419", "latest", "0.12.0"];
    expect(newerTag(tags, "v0.9.9")).toBe("v0.10.0");
    expect(newerTag(tags, "v0.10.0")).toBeUndefined();
    expect(newerTag(["1.2.3-alpine", "1.3.0", "1.3.0-alpine"], "1.2.3-alpine")).toBe(
      "1.3.0-alpine",
    );
  });

  it("names a tag-less pin by its full release before the tag that floats with it", () => {
    expect(releasesNewestFirst(["0.19.0", "0.19", "0.20.0", "0.20", "latest"])).toEqual([
      "0.20.0",
      "0.20",
      "0.19.0",
      "0.19",
    ]);
  });
});
