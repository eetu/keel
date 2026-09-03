import { describe, expect, it } from "vitest";

import {
  appsRoomMb,
  IMAGE_SERVICES,
  priceMemory,
  PROFILES,
  resolveMemory,
  selectProfile,
  tierMaxTotalMb,
} from "../src/config/profiles";
import { SERVICES } from "../src/config/services";
import { type ServiceMemory } from "../src/config/types";
import { memoryDropInPath, renderMemory, serviceDropIn } from "../src/render/memory";
import { CAP_HEADROOM } from "./caps";

/**
 * Every cap either layer owns, named. The catalog's come from the entries that
 * declare the services; unbound's comes from the image's own list, because it is
 * a package rather than a quadlet and has no entry to hang a number on.
 */
const CAPS: readonly (readonly [string, ServiceMemory])[] = [
  ...Object.entries(IMAGE_SERVICES),
  ...SERVICES.map((spec) => [spec.name, spec.memory] as const),
];

describe("profile selection", () => {
  it("treats an unrecognised board as the tightest case", () => {
    expect(selectProfile(512).name).toBe("1g");
    expect(selectProfile(0).name).toBe("1g");
  });

  it("picks the profile the board's RAM qualifies for", () => {
    expect(selectProfile(1024).name).toBe("1g");
    expect(selectProfile(2048).name).toBe("4g");
    expect(selectProfile(4096).name).toBe("4g");
    expect(selectProfile(8192).name).toBe("8g");
  });
});

describe("memory budget", () => {
  // The contract that replaces "avoid Postgres, watch the memory budget" as
  // prose: on every profile, the services that must never be the thing that
  // dies fit inside the board with the reserve intact.
  it.each(PROFILES)("core hard caps fit in $name with its reserve", (profile) => {
    const core = tierMaxTotalMb("core", profile);
    expect(core + profile.reserveMb).toBeLessThanOrEqual(profile.targetRamMb);
  });

  it.each(PROFILES)("$name has room left for the application tier", (profile) => {
    // The apps slice's throttle is what is left after the protected tier and
    // the reserve. A profile where that is zero has budgeted a board on which
    // no app can run.
    expect(appsRoomMb(profile)).toBeGreaterThan(0);
  });
});

describe("service specs", () => {
  it("holds a cap for every service and for nothing else", () => {
    // A cap is a claim about a workload, checked against a measurement from the
    // fleet, so it lives on the entry that declares the workload. A number for
    // something neither layer runs has nowhere to be written down.
    const named = CAPS.map(([name]) => name);
    expect(new Set(named).size).toBe(named.length);
    const real = new Set<string>([
      ...Object.keys(IMAGE_SERVICES),
      ...SERVICES.map((spec) => spec.name),
    ]);
    for (const name of named) expect(real.has(name), name).toBe(true);
  });

  it.each(CAPS)("%s has a usable cap", (_name, memory) => {
    expect(memory.max).toBeGreaterThan(0);
    expect(["core", "apps"]).toContain(memory.tier);
    if (memory.high !== undefined) expect(memory.high).toBeLessThanOrEqual(memory.max);
  });

  it("defaults the soft throttle to 75% of the hard cap", () => {
    // Asserted as a relationship, not a number: the caps come from measurement
    // and are expected to move when the fleet is re-measured.
    const { maxMb, highMb } = resolveMemory("traefik", PROFILES[0]);
    expect(highMb).toBe(Math.round(maxMb * 0.75));
  });

  it.each(CAPS.filter(([, memory]) => memory.measuredMb !== undefined))(
    "%s is capped clear of what it actually uses",
    (_name, memory) => {
      const ratio = memory.max / (memory.measuredMb ?? 1);
      expect(ratio).toBeGreaterThanOrEqual(CAP_HEADROOM.min);
      expect(ratio).toBeLessThanOrEqual(CAP_HEADROOM.max);
    },
  );

  it("scales only the caps that say more RAM buys something", () => {
    // A bigger ceiling makes a scanner faster and an idle reverse proxy exactly
    // as fast as it was. The scaling half is asserted on a declaration written
    // here, because whether any catalog holds a service that scales is a fact
    // about one installation; the other half is asserted on every cap there is.
    const big = PROFILES[2];
    expect(priceMemory({ max: 96, tier: "apps", scales: true }, big).maxMb).toBe(96 * big.scale);
    for (const [name, memory] of CAPS) {
      if (memory.scales === true) continue;
      expect(resolveMemory(name, big).maxMb, name).toBe(memory.max);
    }
  });
});

describe("rendered memory tree", () => {
  const tree = renderMemory();

  it("budgets both slices on every profile", () => {
    // What the board's size actually decides: how much the protected tier is
    // guaranteed, and how much is left for everything else.
    for (const profile of PROFILES) {
      const core = tree.get(`/usr/lib/keel/profiles/${profile.name}/units/keel-core.slice.conf`);
      const apps = tree.get(`/usr/lib/keel/profiles/${profile.name}/units/keel-apps.slice.conf`);
      expect(core?.content, profile.name).toContain(
        `MemoryLow=${tierMaxTotalMb("core", profile)}M`,
      );
      expect(apps?.content, profile.name).toContain(`MemoryHigh=${appsRoomMb(profile)}M`);
    }
  });

  it("caps the services the image itself runs", () => {
    for (const service of Object.keys(IMAGE_SERVICES)) {
      const entry = tree.get(`/usr/lib/systemd/system/${service}.service.d/50-keel-memory.conf`);
      expect(entry?.content, service).toContain(
        `MemoryMax=${resolveMemory(service, PROFILES[0]).maxMb}M`,
      );
      // A packaged unit has no way to know it belongs in a keel slice.
      expect(entry?.content, service).toContain("Slice=keel-");
    }
  });

  it("writes a deployed service's caps where they outrank the image", () => {
    // /etc beats both /usr/lib and the generator's own directory, so the two
    // mechanisms cannot end up racing on load order.
    expect(memoryDropInPath("vaultwarden")).toBe(
      "/etc/systemd/system/vaultwarden.service.d/50-keel-memory.conf",
    );
    const big = serviceDropIn("vaultwarden", PROFILES[2]);
    expect(big).toContain(`MemoryMax=${resolveMemory("vaultwarden", PROFILES[2]).maxMb}M`);
    // The quadlet states the slice; this file states the numbers.
    expect(big).not.toContain("Slice=");
  });

  it("keeps the generator's profile table in step with PROFILES", () => {
    // The generator is shell and cannot import TypeScript, so it reads this
    // table. This test is the only thing stopping the two from drifting.
    const expected = `${PROFILES.map((p) => `${p.name} ${p.minRamMb}`).join("\n")}\n`;
    expect(tree.get("/usr/lib/keel/profiles/index")?.content).toBe(expected);
  });
});
