/**
 * The CIFS shares a host mounts, as systemd mount units.
 *
 * A service that binds a NAS path is the reason a mount exists, and the mount is
 * what makes that service mean what it says: podman creates a missing bind
 * source rather than refusing it, so a music server whose share never got
 * mounted answers with an empty library — a failure that looks like a working
 * service. Which shares a host mounts is therefore read off the deployed set's
 * `mounts` lines, and the ordering between a service and its share is quadlet's
 * own: it derives `RequiresMountsFor=` from every absolute `Volume=` source,
 * which is `Requires=` plus `After=` on the unit that mounts it, so no entry
 * names a mount unit.
 *
 * **The unit is the mount, and the credentials are a file it points at.** The
 * kernel's `credentials=` option is read by `mount.cifs`, which means the login
 * is in a 0600 file rather than in the unit body, in `argv`, or in the journal.
 * That is the one thing a `.mount` unit can do that `mount -o` cannot, and it is
 * why this is a unit rather than the `mount(2)`-through-`ctypes` call the backup
 * uses — the backup has to run on a board whose image has no mount helper at all,
 * while a share a service depends on wants a unit the service can be ordered
 * after and `systemctl stop` can unmount.
 *
 * Pure, so systemd's escaping and what a share's own fields may contain are
 * tests rather than something a deploy discovers.
 */

import { type ServiceSpec } from "../config/spec";
import { type Share } from "../config/types";
import { KEEL_HOSTS_SERVICE } from "./hosts";
import { dedent } from "./tree";

/**
 * What systemd's path escaping leaves alone: digits, letters, and `:_.` — note
 * that `-` is not among them, because `-` is what a `/` becomes.
 */
const LITERAL = /[A-Za-z0-9:_.]/;

/** The filesystem these units mount. */
const FS_TYPE = "cifs";

/**
 * The helper `mount` runs for that filesystem, at the path `mount(8)` itself
 * looks it up under — `/sbin/mount.<type>`, which this image reaches through the
 * `/sbin -> usr/sbin` merge. It reads `credentials=`; the kernel does not, and
 * ignores it rather than refusing it, so its presence is a deploy-time probe
 * (`src/infra/providers/remoteBinary.ts`) rather than a comment.
 */
export const MOUNT_HELPER = `/sbin/mount.${FS_TYPE}`;

/**
 * The root directories this image reaches through a symlink, and what each one
 * actually is.
 *
 * A bootc deployment root is not a physical root. ostree keeps machine-local
 * state under `/var` and the read-only tree under `/usr`, and leaves the
 * traditional names behind as symlinks — `/mnt -> var/mnt`, `/srv -> var/srv`,
 * `/home -> var/home`, `/root -> var/roothome`, `/media -> run/media`, and the
 * four `/usr` merges. That matters here and almost nowhere else in the repo,
 * because a mountpoint is one of the few paths systemd resolves for itself:
 * `Where=/mnt/music` fails to load with _"Mount path /mnt/music is not
 * canonical (contains a symlink)"_, so the unit never mounts anything.
 *
 * The half-fixed version is worse than the broken one, which is why both a
 * share's mountpoint and an entry's `Volume=` source are held to this. podman
 * resolves the symlink when it binds, so a `Volume=/mnt/music` line keeps
 * working — but quadlet writes `RequiresMountsFor=/mnt/music` from that line and
 * systemd does not chase symlinks resolving it either. The service would then
 * hold no dependency at all on the unit that mounts its data.
 *
 * A stale entry fails in the safe direction: a name the base image has since
 * made a real directory is refused here and a person deletes a line, where the
 * reverse is a service answering out of an empty directory.
 */
const ROOT_SYMLINKS: Readonly<Record<string, string>> = {
  bin: "/usr/bin",
  home: "/var/home",
  lib: "/usr/lib",
  lib64: "/usr/lib64",
  media: "/run/media",
  mnt: "/var/mnt",
  root: "/var/roothome",
  sbin: "/usr/sbin",
  srv: "/var/srv",
};

/** A path as the image itself resolves it, or the path unchanged. */
export function canonicalPath(path: string): string {
  const [, first, rest] = /^\/([^/]*)(\/.*)?$/.exec(path) ?? [];
  const target = ROOT_SYMLINKS[first ?? ""];
  return target === undefined ? path : `${target}${rest ?? ""}`;
}

const hex = (byte: number): string => `\\x${byte.toString(16).padStart(2, "0")}`;

/**
 * A path as systemd names the unit that mounts it — `systemd-escape --path`.
 *
 * The rule in full, because a name that differs by one byte is a unit nothing
 * starts: `/` becomes `-`, a leading `.` becomes `\x2e` so the unit file is not
 * hidden, and every other byte outside the literal set — `-` included, non-ASCII
 * byte by byte — becomes `\xNN`. Repeated and trailing slashes are collapsed
 * first, as systemd simplifies a path before escaping it, so `/var/mnt/music/`
 * and `/var/mnt/music` are one mount.
 */
export function mountUnitName(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`a mountpoint must be absolute: ${path}`);
  }
  const simplified = path.replace(/\/+/g, "/").replace(/\/+$/, "");
  if (simplified === "") return "-.mount";
  const bytes = new TextEncoder().encode(simplified.slice(1));
  let escaped = "";
  for (const [index, byte] of bytes.entries()) {
    const char = String.fromCharCode(byte);
    if (index === 0 && char === ".") escaped += hex(byte);
    else if (char === "/") escaped += "-";
    else if (byte < 0x80 && LITERAL.test(char)) escaped += char;
    else escaped += hex(byte);
  }
  return `${escaped}.mount`;
}

/**
 * Whether `host` — a share's or the backup target's — is already an IPv4 or
 * IPv6 literal rather than a name.
 *
 * An address asks nothing of a resolver, and a name that is not one is what
 * `keel-hosts.service` has to be given: this is the predicate the deploy layer
 * filters `INSTALLATION.shares` and `INSTALLATION.backup.host` through to build
 * that unit's own input, so a fleet that addresses its NAS rather than naming it
 * asks the resolver for nothing.
 *
 * A loose classification on purpose — a name may not contain `:` and a NetBIOS
 * name may not parse as four dotted octets, so there is nothing an address and a
 * name could both be mistaken for.
 */
const IPV4_LITERAL = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpAddress(host: string): boolean {
  return IPV4_LITERAL.test(host) || host.includes(":");
}

/**
 * Option names a share may not state. The first seven would put a login in the
 * unit body — mode 644 and in `systemctl cat` — which is the one thing the
 * credentials file exists to prevent; `guest` belongs with them because it
 * authenticates as nobody. `ro` and `rw` follow from `readOnly`, and are written
 * ahead of these options with the kernel honouring the last occurrence — so a
 * stray `rw` here would be the last word on a share declared read-only.
 */
const REFUSED_OPTIONS = new Set([
  "cred",
  "credentials",
  "guest",
  "pass",
  "password",
  "user",
  "username",
  "ro",
  "rw",
]);

/**
 * A share, held to what a mount unit can be built from.
 *
 * Every field here is interpolated into a root-run unit under
 * `/etc/systemd/system`, and a unit file is line-oriented: whitespace in a value
 * is a second word on the `What=` line or, for a newline, a directive of the
 * author's choosing, and a trailing backslash joins the next line onto this one.
 * So no field may carry any of them. The rest is the two systemd traps a
 * mountpoint can fall into, and the login.
 *
 * Called from both `mountUnit` and `mountedShares`, so no unit body is ever
 * composed from an unchecked share whichever way it is reached.
 */
export function assertShare(share: Share): void {
  const canonical = canonicalPath(share.mountpoint);
  if (canonical !== share.mountpoint) {
    throw new Error(
      `the ${share.share} share mounts on ${share.mountpoint}, which this image reaches ` +
        "through a symlink — systemd refuses a mount unit whose Where= is not canonical, so " +
        `state ${canonical} here and in every mounts line that names it`,
    );
  }
  const unit = mountUnitName(share.mountpoint);
  if (unit.includes("\\")) {
    throw new Error(
      `the ${share.share} share mounts on ${share.mountpoint}, which systemd escapes to ${unit} ` +
        "— ssh joins its arguments and the remote shell re-parses them, which eats the backslash " +
        "and leaves systemctl acting on a unit name nothing wrote; a mountpoint therefore holds " +
        "letters, digits, `_`, `.` and `:` only — a dash, a space and every non-ASCII byte " +
        `escape — so mount it on ${share.mountpoint.replace(/[^A-Za-z0-9:_./]/g, "_")} instead`,
    );
  }
  for (const [field, value] of Object.entries({
    host: share.host,
    share: share.share,
    mountOptions: share.mountOptions,
  })) {
    if (/[\s\\]/.test(value)) {
      throw new Error(
        `the ${share.share} share's ${field} ${JSON.stringify(value)} carries whitespace or a ` +
          "backslash — it is interpolated into a unit systemd runs as root, where a space is a " +
          "second word, a newline is a second directive and a trailing backslash continues the " +
          "line into the next one",
      );
    }
  }
  for (const option of share.mountOptions.split(",")) {
    if (REFUSED_OPTIONS.has(option.split("=")[0].toLowerCase())) {
      throw new Error(
        `the ${share.share} share's mount options name ${option}, which a share may not state: a ` +
          "login reaches the mount as a credentials= path, and ro or rw follows from readOnly",
      );
    }
  }
}

/**
 * Where the share's login lands, decrypted.
 *
 * Under `/etc/secrets` because that is the directory `keel-secrets.service`
 * opens `*.age` blobs into: the sealed file is this path plus `.age`, and being
 * in that directory is the whole of how it gets decrypted at boot. Named after
 * the unit rather than the share, so two servers exporting a `music` share are
 * two files.
 */
export function credentialsPath(share: Share): string {
  return `/etc/secrets/${mountUnitName(share.mountpoint).replace(/\.mount$/, "")}.creds`;
}

/**
 * One share's mount unit.
 *
 * `nofail` is load-bearing and not about tolerating failure: without it systemd
 * gives a network mount an implicit `Before=remote-fs.target`, and
 * `systemd-user-sessions.service` is ordered after that target — so a NAS that is
 * off would hold ssh logins for the mount's whole timeout. The mount still runs
 * at boot, a deploy still fails loudly when it cannot mount, and the board stays
 * reachable while the NAS is not.
 *
 * `ro` on a read-only share is a local guarantee on top of the read-only account:
 * the credential is what the server enforces, this is what the kernel does.
 *
 * `keel-hosts.service` is in both `After=` and `Wants=`: `mount.cifs` resolves
 * `host` through `getaddrinfo`, which reads `/etc/hosts` before anything else,
 * so a name has to land there before this unit's first mount attempt or the
 * mount fails with the name unresolved. An address ignores the ordering at no
 * cost — `getaddrinfo` on four dotted octets asks no resolver at all.
 */
export function mountUnit(share: Share): string {
  assertShare(share);
  const source = `//${share.host}/${share.share}`;
  const options = [
    `credentials=${credentialsPath(share)}`,
    ...(share.readOnly ? ["ro"] : ["rw"]),
    "nofail",
    share.mountOptions,
  ].filter(Boolean);
  return dedent(`
    [Unit]
    Description=CIFS share ${source}
    After=network-online.target keel-secrets.service ${KEEL_HOSTS_SERVICE}
    Wants=network-online.target ${KEEL_HOSTS_SERVICE}

    [Mount]
    What=${source}
    Where=${share.mountpoint}
    Type=${FS_TYPE}
    Options=${options.join(",")}
    # The mountpoint itself, for the window in which nothing is mounted on it:
    # credentialed access to the NAS is not something to leave a directory open
    # onto, and a writable empty directory would be shadowed rather than filled.
    DirectoryMode=0700

    [Install]
    WantedBy=multi-user.target
  `);
}

/** A share something mounts, with everything derived from it in one place. */
export type MountedShare = {
  share: Share;
  unit: string;
  credentials: string;
  /** The deployed entries that bind a path under it, sorted. */
  consumers: readonly string[];
};

/** The host side of a quadlet `Volume=` line. */
const hostPaths = (spec: ServiceSpec): readonly string[] =>
  (spec.mounts ?? []).map((mount) => mount.split(":")[0]);

const under = (path: string, mountpoint: string): boolean =>
  path === mountpoint || path.startsWith(`${mountpoint}/`);

/**
 * The shares a deployed set actually mounts: every share some entry binds a path
 * under, with the entries that do.
 *
 * A share nothing mounts is not an error and gets no unit: the network has
 * shares this host has no reason to hold credentialed access to. A path under no
 * share is not an error either — `/var/lib/<name>` is a directory the quadlet
 * creates, and a NAS path nobody declared a share for fails on the board when
 * podman is handed a source that does not exist.
 */
export function mountedShares(
  specs: readonly ServiceSpec[],
  shares: readonly Share[],
): readonly MountedShare[] {
  const seen = new Set<string>();
  for (const share of shares) {
    // Every declared share, not only the ones something mounts: a share whose
    // fields could not build a unit is a config error the moment it is written,
    // and finding out when a service starts binding it is finding out late.
    assertShare(share);
    const unit = mountUnitName(share.mountpoint);
    if (seen.has(unit)) {
      throw new Error(`two shares mount on ${share.mountpoint} — ${unit} can only be one of them`);
    }
    seen.add(unit);
  }
  // Longest mountpoint first, so a share nested inside another is matched by the
  // one that actually holds the path.
  const byDepth = [...shares].sort((a, b) => b.mountpoint.length - a.mountpoint.length);

  const mounted = new Map<string, MountedShare>();
  for (const spec of specs) {
    for (const path of hostPaths(spec)) {
      const canonical = canonicalPath(path);
      if (canonical !== path) {
        throw new Error(
          `${spec.name} binds ${path}, which this image reaches through a symlink — podman ` +
            "resolves it and quadlet's RequiresMountsFor= does not, which would leave the " +
            `service with no dependency on the mount at all; bind ${canonical}`,
        );
      }
      const share = byDepth.find((candidate) => under(path, candidate.mountpoint));
      if (share === undefined) continue;
      const unit = mountUnitName(share.mountpoint);
      const already = mounted.get(unit);
      mounted.set(unit, {
        share,
        unit,
        credentials: credentialsPath(share),
        consumers: [...new Set([...(already?.consumers ?? []), spec.name])].sort(),
      });
    }
  }
  // Sorted by unit, so which shares a host mounts does not depend on the order
  // the catalog happens to be written in. On code units rather than
  // `localeCompare`, whose collation is the runtime's default locale — a
  // renderer's output depends on its argument and nothing else.
  return [...mounted.values()].sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
}
