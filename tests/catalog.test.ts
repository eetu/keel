/**
 * What keeps the committed half of this repository an example somebody else can
 * adopt.
 *
 * Three properties, each of which rots silently. A committed entry that names one
 * house publishes it and is wrong for everybody else. A clone that cannot be
 * brought up from what is committed plus the two `.example.ts` files is a
 * repository nobody can start from, and the person who would find out is the one
 * least able to fix it. And an image whose content depends on the local catalog
 * is no longer the artefact CI builds — so a board would run a tree nobody
 * tested.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INSTALLATION } from "../src/config/installation";
import { IMAGE_SERVICES, priceMemory, PROFILES, tierMaxTotalMb } from "../src/config/profiles";
import { composeCatalog, EXAMPLE_SERVICES, SERVICES } from "../src/config/services";
import { LOCAL_SERVICES } from "../src/config/services.local";
import { type ServiceSpec } from "../src/config/spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

/** A fixture entry, so a rule is asserted on a declaration and not on a house. */
const plain = (name: string): ServiceSpec => ({
  name,
  description: "fixture",
  image: `example.test/${name}@sha256:${"0".repeat(64)}`,
  port: 9000,
  memory: { max: 32, tier: "apps" },
  subdomain: null,
  auth: "open",
});

describe("the catalog is two lists and one reading", () => {
  it("appends the installation's own to the example one and refuses a name claimed twice", () => {
    // Every consumer iterates `SERVICES`, so this is the only place the split
    // exists: a local entry is held to exactly what an example one is. A name is
    // the container, the unit, the subdomain and the state directory, so a second
    // entry does not shadow the first — it deploys a unit over it and mounts one
    // `/var/lib` into two different images.
    expect(SERVICES).toEqual([...EXAMPLE_SERVICES, ...LOCAL_SERVICES]);
    expect(() => composeCatalog([plain("thing")], [plain("thing")])).toThrow(
      /'thing' \(src\/config\/services\.ts and src\/config\/services\.local\.ts\)/,
    );
    expect(() => composeCatalog([], [plain("thing"), plain("thing")])).toThrow(
      /'thing' \(twice in src\/config\/services\.local\.ts\)/,
    );
  });
});

describe("the example catalog names nobody's installation", () => {
  /**
   * Everything an entry declares, as text. `JSON.stringify` drops the functions,
   * which is exactly right: a `setup` is where an entry is *allowed* to name the
   * house, because it is handed the installation rather than spelling it.
   */
  const declared = (spec: ServiceSpec) => JSON.stringify(spec);

  /**
   * The values that identify one installation. The backup share and repository
   * directory are deliberately absent: names like `backups` or `data` occur in
   * any mount path, so matching on them would fail an entry for a coincidence.
   * Host names are absent too: a board is named by its key in
   * `INSTALLATION.hosts` and reached by a stack, never by an entry — which is
   * the property the loopback test below holds, without a name list.
   */
  const identifying = [
    INSTALLATION.vault,
    INSTALLATION.network.domain,
    INSTALLATION.network.lanCidr,
    INSTALLATION.mesh.v4,
    INSTALLATION.mesh.v6,
    INSTALLATION.smtp.host,
    INSTALLATION.backup.host,
    ...INSTALLATION.publicHosts,
  ];

  it.each(EXAMPLE_SERVICES)("$name states nothing from the installation", (spec) => {
    for (const value of identifying) {
      expect(declared(spec), value).not.toContain(value);
    }
  });

  it.each(EXAMPLE_SERVICES)("$name names no address but loopback and the wildcard", (spec) => {
    // A LAN address, a bridge, a NAS or a resolver upstream is a fact about one
    // network. The two an entry may name are facts about any host: where the
    // proxy dials an upstream, and what a server inside a namespace binds.
    const addresses = declared(spec).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
    for (const address of addresses) {
      expect(["0.0.0.0", "127.0.0.1"], `${spec.name}: ${address}`).toContain(address);
    }
  });

  it.each(EXAMPLE_SERVICES)("$name dials no machine but the one it runs on", (spec) => {
    // Every URL pointing at the outside is composed in `setup` from the
    // installation's own domain, so what is left in the declaration is one
    // process talking to another on the same host — which is loopback.
    for (const [, authority] of declared(spec).matchAll(/\bhttps?:\/\/([^/"\\\s]*)/gi)) {
      const host = authority.replace(/:\d+$/, "");
      expect(["127.0.0.1", "localhost", "[::1]"], `${spec.name}: ${authority}`).toContain(host);
    }
  });

  it.each(EXAMPLE_SERVICES)("$name pins an image nobody has to build", (spec) => {
    // A tag is resolved to a digest at deploy time, which is what an app built by
    // its own owner's CI needs — and an image reference into somebody's personal
    // namespace is the most easily missed way to name an installation. The
    // example catalog is published products, each pinned by digest.
    expect(spec.image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});

describe("a clone can be brought up from what is committed", () => {
  /** Every gitignored module under `src/config`, read out of `.gitignore` itself. */
  const gitignored = read(".gitignore")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^src\/config\/[\w.]+\.ts$/.test(line));

  it("has two of them, which is what the documented copy step copies", () => {
    // A third that nobody knows about is the failure this counts against: the
    // quickstart, CI and this file would all still pass while a clone stopped
    // typechecking.
    expect(gitignored).toEqual(["src/config/installation.ts", "src/config/services.local.ts"]);
  });

  it.each(gitignored)("%s has a committed twin", (path) => {
    // The twin is what a clone copies into place, and `tsconfig.json` includes
    // it — so `yarn typecheck` holds it to the same types as the file it stands
    // in for, and an example that drifted out of shape fails here rather than in
    // somebody's first hour.
    expect(() => read(path.replace(/\.ts$/, ".example.ts"))).not.toThrow();
  });
});

describe("the image is the committed configuration's", () => {
  it("budgets the protected tier from the example catalog alone", () => {
    // The slice budgets the image ships are the sum of the core tier's caps, so a
    // local entry claiming that tier would change the rendered tree — and the
    // artefact on the bench is the one CI builds from committed configuration.
    const committed = [...Object.values(IMAGE_SERVICES), ...EXAMPLE_SERVICES.map((s) => s.memory)];
    for (const profile of PROFILES) {
      const total = committed
        .filter((memory) => memory.tier === "core")
        .reduce((sum, memory) => sum + priceMemory(memory, profile).maxMb, 0);
      expect(tierMaxTotalMb("core", profile), profile.name).toBe(total);
    }
  });
});
