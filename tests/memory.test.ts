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
import { catalogOf, type ServiceSpec } from "../src/config/spec";
import { type ServiceMemory } from "../src/config/types";
import { memoryDropInPath, renderMemory, serviceDropIn } from "../src/render/memory";
import { renderQuadlet } from "../src/render/quadlet";
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

  it("puts the soft ceiling at the cap and never under it", () => {
    // Both halves of this were learned the hard way. At 75% of the cap it sat
    // under the binary — a cgroup is charged its executable's text as *file*
    // pages — so the kernel evicted text the process faulted straight back in:
    // 528 MB reclaimed every 20s by the gate alone, at 34 MB against a 36 MB
    // ceiling. Removing it entirely was worse, because a soft ceiling is what
    // confines a cgroup so its growth is not everyone else's problem: unconfined,
    // the board went to 5,622 MB/20s, 83% io pressure, and off the network.
    const { maxMb, highMb } = resolveMemory("traefik", PROFILES[0]);
    expect(highMb).toBe(maxMb);
    expect(serviceDropIn("traefik", PROFILES[0])).toContain(`MemoryHigh=${maxMb}M`);
  });

  it("honours one an entry states, and writes it", () => {
    // The escape hatch stays for a service that genuinely wants throttling short
    // of its ceiling — asserted on a declaration written here, because whether
    // any catalog happens to hold one is a fact about an installation.
    const throttled = priceMemory({ max: 64, high: 48, tier: "apps" }, PROFILES[0]);
    expect(throttled.highMb).toBe(48);
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

  it("weights the apps tier down and leaves every other slice alone", () => {
    // A boot starts two dozen containers at once, and the resolver and the proxy
    // compete with all of them. The apps' weight is the only one stated: raising
    // the core's would take the same shares from system.slice, where sshd and
    // unbound are — so the tier that must answer would win against the apps and
    // lose against the path back into the board.
    const core = tree.get("/usr/lib/systemd/system/keel-core.slice");
    const apps = tree.get("/usr/lib/systemd/system/keel-apps.slice");
    expect(apps?.content).toContain("CPUWeight=50");
    expect(core?.content).not.toContain("CPUWeight=");
    // A weight and not a quota: nothing here may cap the tier outright, or an
    // idle core tier would leave the board's CPU unused.
    expect(apps?.content).not.toContain("CPUQuota=");
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

describe("who the kernel kills when the machine runs out of memory", () => {
  /** A fixture per tier, so the rule is asserted on a declaration not a house. */
  const entry = (tier: "core" | "apps"): ServiceSpec => ({
    name: `fixture-${tier}`,
    description: "fixture",
    image: "x@sha256:0",
    port: 1,
    memory: { max: 64, tier },
    auth: "open",
  });

  it("prefers an app over the resolver, the proxy and the identity provider", () => {
    // A *global* OOM is a different event from a cgroup hitting its ceiling, and
    // only the second was ever configured: MemoryLow protects the core tier from
    // reclaim and MemoryMax bounds each service, but the kernel's killer ignores
    // both and scores by size. Every container arrived at zero, so the victim was
    // whoever happened to be largest — measured here as pihole-FTL, which is the
    // LAN's resolver, killed by an allocation in an Actix app.
    const core = renderQuadlet(entry("core"), undefined, catalogOf([]));
    const apps = renderQuadlet(entry("apps"), undefined, catalogOf([]));
    expect(core).toContain("OOMScoreAdjust=-500");
    expect(apps).toContain("OOMScoreAdjust=500");
  });

  it("gives oomd a turn before the kernel picks", () => {
    // Pressure killing needs 60% sustained for thirty seconds. Once swap is full
    // an allocation that cannot be satisfied invokes the kernel's killer at once,
    // and there is no thirty seconds for pressure to build — so the slice has to
    // say it wants killing on swap exhaustion too, or oomd never acts at all.
    const slice = renderMemory().get("/usr/lib/systemd/system/keel-apps.slice")?.content ?? "";
    expect(slice).toContain("ManagedOOMSwap=kill");
    expect(slice).toContain("ManagedOOMMemoryPressure=kill");
  });
});
