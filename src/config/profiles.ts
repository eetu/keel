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
 *
 * **`MemoryHigh` sits at the hard cap, and the history is why.** It was once
 * `max * 0.75`, which lands under the binary for every Go and Rust service here:
 * a cgroup is charged its executable's text as _file_ pages, and these hold
 * almost nothing else — `anon 0.1 MB / file 29 MB` for the gate, `file 141` for
 * the proxy. So the kernel was made to evict text the process faulted straight
 * back in, and lifting the gate's ceiling alone took it from 528 MB reclaimed
 * every twenty seconds to none.
 *
 * Removing it from *every* service then made the board far worse rather than
 * better: reclaim 2,265 -> 5,622 MB per twenty seconds, disk reads 725 -> 2,754,
 * io pressure 47% -> 83%, and finally a board that fell off the network under its
 * own IO and had to be power-cycled. The single-service result did not
 * generalise, and the reason is exactly what the setting is for — a soft ceiling
 * confines a cgroup so its growth is not everyone else's problem. With all of
 * them unconfined the machine reclaims globally instead, which is untargeted and
 * costs far more than the per-cgroup reclaim it replaced.
 *
 * So the ceiling stays, and sits *at* the cap rather than under it: still
 * confined, never below what the service's own binary needs. Measured back down
 * to 2,787 MB/20s and 23% io pressure from the 83% the unconfined board sat at.
 *
 * What remains genuinely wrong is a `max` set below a binary's text — ntfy at 48
 * against a 62 MB binary, the proxy at 128 against 167. That is a number on an
 * entry, fixed by measuring the binary, and not a rule to encode here.
 *
 * `high` on an entry still overrides, for a service that wants throttling short
 * of its ceiling. Nothing in the committed catalog does.
 */
export function priceMemory(memory: ServiceMemory, profile: Profile): ResolvedMemory {
  const maxMb = maxUnder(memory, profile);
  return { maxMb, highMb: memory.high ?? maxMb, tier: memory.tier };
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
 * Sum of what one tier is *observed* to hold, for the entries that record it.
 *
 * `measuredMb` is what a service was seen using; `max` is the ceiling it may
 * never cross. Both are true and they answer different questions, so the two
 * totals are kept apart rather than one standing in for the other. An entry
 * without an observation falls back to its cap, which is the conservative
 * reading — an unmeasured service is assumed to want everything it is allowed.
 */
export function tierMeasuredTotalMb(tier: Tier, profile: Profile): number {
  return everyCap()
    .filter((memory) => memory.tier === tier)
    .reduce((sum, memory) => sum + (memory.measuredMb ?? maxUnder(memory, profile)), 0);
}

/**
 * What is left for the application tier once the protected tier and the kernel's
 * reserve are accounted for. This is the number the `keel-apps.slice` throttle
 * carries: the apps' own caps may add up to more than it, deliberately, and the
 * slice is where that overcommitment is resolved rather than on the board.
 *
 * Priced against what the core tier *holds* and not against what it may hold,
 * and that difference is the whole of this function. The two numbers serve
 * different mechanisms: `MemoryLow` on the core slice is a protection, and it
 * uses the cap sum, because under real contention the core tier must be able to
 * grow into every megabyte it is allowed. `MemoryHigh` here is a throttle, and
 * it binds *always* — so pricing it against the same worst case withholds the
 * gap between the two from the apps at every moment the worst case is not
 * happening, which is nearly all of them.
 *
 * Measured on a 1 GB board: the core tier's caps total 464 MB against 176 MB
 * actually held, so the apps were throttled to 240 MB while 390 MB sat free and
 * 137 MB of their working set lived in compressed swap — paid for at every
 * access as a major fault. The overlap the two numbers now have is deliberate
 * and safe in exactly one direction: a throttle that lets the apps use free
 * memory costs nothing when the core tier later wants it back, because the
 * protection is what decides that case.
 */
export function appsRoomMb(profile: Profile): number {
  return profile.targetRamMb - profile.reserveMb - tierMeasuredTotalMb("core", profile);
}
