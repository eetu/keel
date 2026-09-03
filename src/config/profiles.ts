/**
 * Memory profiles — how the image sizes itself to whatever board it boots on.
 *
 * One image runs on a 1 GB Pi 3 B+, a 1 GB Pi 4 or an 8 GB board. The renderer
 * emits a drop-in set per profile; a systemd generator reads MemTotal at boot,
 * picks the matching set and stages it into the runtime tree. Nothing about the
 * board is decided at build time.
 *
 * The caps themselves are not here: each one lives on the entry that declares
 * the service it caps, so a number is read beside the workload it is a claim
 * about. What this file owns is the profiles, the arithmetic that prices a cap
 * against one, and the caps for the services the image itself runs.
 *
 * Those caps encode a real property of this fleet: almost every service is a Go
 * or Rust binary sitting idle, and they are never all hot at once. So
 * `MemoryHigh` is allowed to overcommit — the sum across a slice may exceed RAM,
 * and pressure throttles whoever is actually allocating. `MemoryMax` is the hard
 * kill, and only the *core* slice's hard caps are held inside a real budget,
 * because that is the set which must never be the thing that dies.
 *
 * Caps are derived from resident sizes measured on the running fleet, at roughly
 * 2.5x observed with room for a scan or a pack, not guessed. That ratio is the
 * point: a cap far above the workload never fires, so the board runs out of
 * memory long before the cgroup intervenes, while one close to it fires during
 * normal operation. Re-measure with `systemd-cgtop -1 -n1 --order=memory` on a
 * host under normal load before changing one.
 */

import { SERVICES } from "./services";
import { type ServiceMemory, type Tier } from "./types";

/**
 * Services the image itself runs, and therefore the only caps the image ships.
 * Everything else is a `SERVICES` entry, capped by the drop-in the deploy layer
 * writes for the board it is deploying to.
 *
 * Unbound is the whole list: it is a package rather than a quadlet, so a host
 * boots with a working recursive resolver and Pulumi entirely absent — which is
 * also why its cap cannot live on a catalog entry.
 */
export const IMAGE_SERVICES: Record<string, ServiceMemory> = {
  unbound: { max: 64, measuredMb: 25, tier: "core" },
};

/** Every cap either layer owns, whichever declaration it came from. */
function everyCap(): readonly ServiceMemory[] {
  return [...Object.values(IMAGE_SERVICES), ...SERVICES.map((spec) => spec.memory)];
}

/** A named service's cap, from whichever layer runs it. */
function capOf(service: string): ServiceMemory {
  const image = IMAGE_SERVICES[service];
  if (image) return image;
  const spec = SERVICES.find((candidate) => candidate.name === service);
  if (!spec) throw new Error(`no memory spec for service '${service}'`);
  return spec.memory;
}

export type Profile = {
  name: string;
  /** Lowest MemTotal (MiB) that selects this profile. */
  minRamMb: number;
  /** The board size this profile is budgeted against. */
  targetRamMb: number;
  /** Multiplier applied to the caps of `scales: true` services. */
  scale: number;
  /** Held back for the kernel, systemd, podman and page cache. */
  reserveMb: number;
};

/**
 * Ordered smallest first. `minRamMb: 0` on the first entry makes it the
 * fallback, so an unrecognised board is treated as the tightest case rather
 * than the most generous one.
 */
export const PROFILES: readonly Profile[] = [
  { name: "1g", minRamMb: 0, targetRamMb: 1024, scale: 1, reserveMb: 320 },
  { name: "4g", minRamMb: 2048, targetRamMb: 4096, scale: 2, reserveMb: 512 },
  { name: "8g", minRamMb: 6144, targetRamMb: 8192, scale: 4, reserveMb: 768 },
];

/** The profile a board with `ramMb` of RAM gets. Mirrored by the generator. */
export function selectProfile(ramMb: number): Profile {
  let chosen = PROFILES[0];
  for (const profile of PROFILES) {
    if (ramMb >= profile.minRamMb) chosen = profile;
  }
  return chosen;
}

export type ResolvedMemory = {
  maxMb: number;
  highMb: number;
  tier: Tier;
};

/** A cap's hard ceiling under a profile: bigger only where more RAM buys something. */
function maxUnder(memory: ServiceMemory, profile: Profile): number {
  return memory.scales === true ? memory.max * profile.scale : memory.max;
}

/**
 * What one cap costs under a profile. Exported apart from the lookup so the
 * arithmetic can be checked against a declaration written on the spot: whether
 * any catalog happens to hold a service that scales is a fact about one
 * installation, and the pricing rule is not.
 */
export function priceMemory(memory: ServiceMemory, profile: Profile): ResolvedMemory {
  const maxMb = maxUnder(memory, profile);
  const highMb = memory.high !== undefined ? memory.high : Math.round(maxMb * 0.75);
  return { maxMb, highMb, tier: memory.tier };
}

/** A named service's caps under a given profile. */
export function resolveMemory(service: string, profile: Profile): ResolvedMemory {
  return priceMemory(capOf(service), profile);
}

/**
 * Sum of hard caps for one tier under a profile. The `core` figure plus the
 * profile's reserve is the number that must stay under the board's RAM — see
 * the budget test.
 */
export function tierMaxTotalMb(tier: Tier, profile: Profile): number {
  return everyCap()
    .filter((memory) => memory.tier === tier)
    .reduce((sum, memory) => sum + maxUnder(memory, profile), 0);
}

/**
 * What is left for the application tier once the protected tier and the kernel's
 * reserve are accounted for. This is the number the `keel-apps.slice` throttle
 * carries: the apps' own caps may add up to more than it, deliberately, and the
 * slice is where that overcommitment is resolved rather than on the board.
 */
export function appsRoomMb(profile: Profile): number {
  return profile.targetRamMb - profile.reserveMb - tierMaxTotalMb("core", profile);
}
