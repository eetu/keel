import {
  appsRoomMb,
  IMAGE_SERVICES,
  type Profile,
  PROFILES,
  resolveMemory,
  tierMaxTotalMb,
} from "../config/profiles";
import { dedent, file, merge, script, type Tree } from "./tree";

const PROFILE_ROOT = "/usr/lib/keel/profiles";

/**
 * Two slices, because "which service may be killed" is the only memory question
 * that matters on a 1 GB board. `keel-core` holds the resolver, the proxy and
 * the IdP: it is protected from reclaim and systemd-oomd never targets it.
 * `keel-apps` holds everything else and is where pressure is resolved.
 *
 * The units carry the policy and no numbers. The numbers are a property of the
 * board, so they arrive in the profile drop-in the generator stages — one owner,
 * chosen at boot.
 */
function slices(): Tree {
  return merge(
    file(
      "/usr/lib/systemd/system/keel-core.slice",
      // No [Slice] section: the tier is protected by the `MemoryLow` its profile
      // drop-in carries, and by systemd-oomd having no policy for it — oomd acts
      // on a cgroup only where `ManagedOOM*` says so, which is the apps slice
      // and nowhere else.
      dedent(`
        [Unit]
        Description=keel core services (resolver, proxy, identity)
        Before=slices.target
      `),
    ),
    file(
      "/usr/lib/systemd/system/keel-apps.slice",
      dedent(`
        [Unit]
        Description=keel application services
        Before=slices.target

        [Slice]
        # systemd-oomd resolves memory pressure here and only here: an app dies
        # before the LAN loses its resolver.
        ManagedOOMMemoryPressure=kill
        ManagedOOMMemoryPressureLimit=60%
      `),
    ),
  );
}

/**
 * The profile table the generator reads, ascending by threshold so the last
 * matching line wins. Kept in the image rather than compiled into the generator
 * so a profile change is a rendered-file change like everything else.
 */
function profileIndex(): Tree {
  const rows = PROFILES.map((profile) => `${profile.name} ${profile.minRamMb}`).join("\n");
  return file(`${PROFILE_ROOT}/index`, `${rows}\n`);
}

/** Composed line by line: an interpolated block would carry its own indentation. */
function capLines(service: string, profile: Profile): readonly string[] {
  const { maxMb, highMb } = resolveMemory(service, profile);
  return [`MemoryHigh=${highMb}M`, `MemoryMax=${maxMb}M`];
}

/**
 * A service's caps, as a unit drop-in.
 *
 * `Slice=` is deliberately not here: a quadlet sets it, and a native unit gets it
 * from `nativeDropIn` below. What this file owns is the two numbers, wherever it
 * is written from — the image stages it per profile for its own services, and the
 * deploy layer writes it directly for a service it manages, knowing the board.
 */
export function serviceDropIn(service: string, profile: Profile): string {
  return `${["[Service]", ...capLines(service, profile)].join("\n")}\n`;
}

/** Where the deploy layer writes it. `/etc` because Pulumi owns it, not the image. */
export function memoryDropInPath(service: string): string {
  return `/etc/systemd/system/${service}.service.d/50-keel-memory.conf`;
}

/**
 * The same two numbers for a service the image itself runs, plus the slice a
 * packaged unit has no way to know it belongs in.
 *
 * Static rather than staged per profile: unbound does not scale with the board,
 * and its cache sizes are compiled into the image from the smallest profile's cap
 * (see `dns.ts`), so a larger ceiling on a larger board would buy nothing and
 * split the number that config is derived from across three files.
 */
function nativeDropIn(service: string): Tree {
  const { tier } = resolveMemory(service, PROFILES[0]);
  const lines = [
    "[Service]",
    // A packaged unit has no way to know it belongs in a keel slice; a quadlet
    // states this itself.
    `Slice=keel-${tier}.slice`,
    ...capLines(service, PROFILES[0]),
  ];
  return file(
    `/usr/lib/systemd/system/${service}.service.d/50-keel-memory.conf`,
    `${lines.join("\n")}\n`,
  );
}

/**
 * The slice budgets, one set per profile. The tiers are what the board's size
 * actually decides: how much the protected tier is guaranteed, and how much room
 * is left for everything else.
 */
function sliceBudgets(): Tree {
  const trees: Tree[] = [];
  for (const profile of PROFILES) {
    trees.push(
      file(
        `${PROFILE_ROOT}/${profile.name}/units/keel-core.slice.conf`,
        dedent(`
          [Slice]
          # The tier's hard-cap total, so the guarantee holds however hard the
          # apps push.
          MemoryLow=${tierMaxTotalMb("core", profile)}M
        `),
      ),
      file(
        `${PROFILE_ROOT}/${profile.name}/units/keel-apps.slice.conf`,
        dedent(`
          [Slice]
          # What the board has left once the core tier and the reserve are
          # accounted for. The apps' own caps may total more than this on
          # purpose: they are idle Go and Rust binaries and are never all hot at
          # once, and throttling here is how that is resolved.
          MemoryHigh=${appsRoomMb(profile)}M
        `),
      ),
    );
  }
  return merge(...trees);
}

/**
 * A systemd system generator: picks a profile from MemTotal and symlinks that
 * profile's drop-ins into the normal generator directory, which sits above
 * /usr/lib in the unit load path and below /etc — so the profile overrides the
 * shipped unit and a hand-written /etc override still wins. That last part is
 * what lets the deploy layer own a service's own caps: its drop-in is in /etc.
 *
 * POSIX sh only, and no systemctl: generators run before the manager is up.
 */
function generator(): Tree {
  return script(
    "/usr/lib/systemd/system-generators/keel-memory-generator",
    dedent(`
      #!/bin/sh
      set -eu

      normal_dir="\${1:-}"
      [ -n "$normal_dir" ] || exit 0

      root=${PROFILE_ROOT}
      [ -f "$root/index" ] || exit 0

      # An explicit kernel argument wins, which is also how the image tests
      # exercise a profile the build host does not have the RAM for.
      profile=$(sed -n 's/.*keel\\.mem_profile=\\([A-Za-z0-9_]*\\).*/\\1/p' /proc/cmdline)

      if [ -z "$profile" ]; then
          ram=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
          profile=$(awk -v ram="$ram" '$2 <= ram { name = $1 } END { print name }' "$root/index")
      fi

      src="$root/$profile/units"
      [ -d "$src" ] || exit 0

      for conf in "$src"/*.conf; do
          [ -e "$conf" ] || continue
          unit=$(basename "$conf" .conf)
          mkdir -p "$normal_dir/$unit.d"
          ln -sf "$conf" "$normal_dir/$unit.d/50-keel-memory.conf"
      done
    `),
  );
}

/**
 * zram as the OOM safety net, replacing a swapfile on the boot media.
 *
 * `ram / 2` is a formula zram-generator evaluates on the running board, so one
 * file is correct at every size and needs no profile. The size comes from
 * measurement: the fleet runs with ~300 MB of swap in use, so the `ram / 4` the
 * old repo asked for would have been tighter than what it actually had — that
 * config never took effect, because activating zram only when absent never
 * resizes an existing device. Headroom is close to free either way, since zram
 * only costs what it holds: 280 MB of swapped data compresses to 47 MB of RAM.
 *
 * lz4 over zstd because both boards in the fleet are 1 GB and CPU is the scarcer
 * resource there; switch to zstd once nothing under 4 GB is left.
 */
function zram(): Tree {
  return file(
    "/usr/lib/systemd/zram-generator.conf",
    dedent(`
      [zram0]
      zram-size = ram / 2
      compression-algorithm = lz4
    `),
  );
}

/**
 * Everything memory-related the image owns: the two slices and their per-profile
 * budgets, the caps for the services the image itself runs, the generator that
 * picks a profile, and zram.
 *
 * A service the deploy layer runs is not here. Pulumi knows the board's RAM, so
 * it writes that service's drop-in itself when it writes the quadlet — one
 * declaration, one deploy, and no window in which a quadlet exists on a host
 * whose image has never heard of it.
 */
export function renderMemory(): Tree {
  return merge(
    slices(),
    profileIndex(),
    sliceBudgets(),
    merge(...Object.keys(IMAGE_SERVICES).map((service) => nativeDropIn(service))),
    generator(),
    zram(),
  );
}
