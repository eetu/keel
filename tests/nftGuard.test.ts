import { describe, expect, it } from "vitest";

import { renderNftGuard } from "../src/render/nftGuard";

describe("the world guard", () => {
  const lines = renderNftGuard(true).split("\n");
  const firstDrop = lines.findIndex((line) => line.includes("drop"));

  it("runs ahead of the image's input chain, where a drop is final", () => {
    expect(lines).toContain("        type filter hook input priority filter - 1; policy accept;");
  });

  it("never counts the LAN, the mesh, loopback or an established flow", () => {
    for (const exempt of ['iif "lo"', "ct state != new", "@lan4", "@mesh4", "@mesh6"]) {
      const at = lines.findIndex((line) => line.includes(exempt) && line.endsWith("accept"));
      expect(at, exempt).toBeGreaterThan(-1);
      expect(at, exempt).toBeLessThan(firstDrop);
    }
  });

  it("limits only the ports that answer the internet", () => {
    const drops = lines.filter((line) => line.includes("drop"));
    expect(drops).toHaveLength(4);
    for (const drop of drops) expect(drop).toMatch(/dport @world_(tcp|udp) /);
  });

  it("is a comment and no table on a host that opens nothing", () => {
    expect(renderNftGuard(false)).not.toContain("table");
  });
});
