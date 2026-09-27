import { describe, expect, it } from "vitest";

import { splitRefresh } from "../scripts/refreshOnce";

describe("a deploy that refreshes", () => {
  it("reads the board once, then plans against what it read", () => {
    const split = splitRefresh(["up", "--refresh", "--parallel", "4", "-s", "raspi", "--yes"]);
    expect(split).toEqual({
      // No preview of its own: that would be the second read pass again.
      refresh: ["refresh", "--skip-preview", "--yes", "-s", "raspi", "--parallel", "4"],
      up: ["up", "--parallel", "4", "-s", "raspi", "--yes"],
    });
  });

  it("confirms the up and not the refresh when no --yes is given", () => {
    const split = splitRefresh(["up", "--refresh", "--stack", "raspo"])!;
    expect(split.up).not.toContain("--yes");
    expect(split.refresh).toContain("--yes");
  });

  it("is left alone when the last --refresh says false, or there is none", () => {
    expect(splitRefresh(["up", "--refresh", "--parallel", "4", "--refresh=false"])).toBeNull();
    expect(splitRefresh(["up", "--parallel", "4"])).toBeNull();
    expect(splitRefresh(["preview", "--refresh", "-s", "raspi"])).toBeNull();
  });
});
