/**
 * Restic backups of service state, for a board whose image has neither restic
 * nor `mount.cifs` in `/usr`.
 *
 * Both are borrowed rather than installed, and neither borrowing is a workaround
 * that stops being true later:
 *
 * - **The mount is the kernel's.** `cifs` is a kernel filesystem; `mount.cifs`
 *   only ever translated a credentials file into option bytes and resolved the
 *   server's name. Calling `mount(2)` with the same option string does the whole
 *   job, and it does it without putting a password in any process's argv — which
 *   is something neither `mount -o` nor a `.mount` unit can claim.
 * - **restic runs from a pinned container**, with the repository and the
 *   backed-up paths bind-mounted in at their real paths, so a snapshot records
 *   `/var/lib/kanidm` and a restore puts it back where it came from.
 *
 * Everything installation-specific — which share, which directory, which mount
 * options — arrives in a config file the Pulumi layer writes. The script holds
 * no address, no share name and no path list, and the snapshot set is derived
 * from the service catalog: `backup: true` on an entry is the whole declaration.
 */

import {
  BACKUP_MEMORY_MB,
  BACKUP_SCHEDULE,
  BACKUP_TAG,
  PRUNE_MAX_UNUSED,
  PRUNE_SCHEDULE,
  RANDOMIZED_DELAY,
  RESTIC_CACHE_DIR,
  RESTORE_DIR,
  RETENTION,
  RETENTION_GROUP_BY,
  SHARE_MOUNTPOINT,
} from "../config/backup";
import { backupPath, type ServiceSpec } from "../config/spec";
import { type BackupTarget } from "../config/types";
import { dedent } from "./tree";

/** The unit pair's names. Both timers are enabled by the deploy layer. */
export const BACKUP_UNIT = "keel-backup";
export const PRUNE_UNIT = "keel-prune";

/**
 * The script and its configuration live under `/etc/keel`, beside the units that
 * run them, because `/usr` — `/usr/local` included — is read-only on this image.
 * The script is data to systemd, not an executable: `ExecStart` names the
 * interpreter and passes the path, which keeps SELinux out of it (init executes
 * `bin_t` python and only *reads* the `etc_t` file).
 */
export const BACKUP_SCRIPT_PATH = "/etc/keel/backup.py";
export const BACKUP_CONFIG_PATH = "/etc/keel/backup.json";

/**
 * The credentials, decrypted from the sealed blob by `keel-secrets.service`:
 * `RESTIC_PASSWORD`, `SMB_USERNAME`, `SMB_PASSWORD`. Same path shape a service's
 * env file gets, and read by the script rather than by systemd — an
 * `EnvironmentFile=` would put all three in the unit's environment, where
 * anything the unit runs inherits them.
 */
export const BACKUP_SECRETS_PATH = "/etc/secrets/keel-backup.env";

/** Environment variable names the script expects to find in that file. */
export const BACKUP_SECRET_VARS = ["RESTIC_PASSWORD", "SMB_USERNAME", "SMB_PASSWORD"] as const;

export type BackupSet = {
  /** Absolute paths the snapshot covers, sorted. */
  paths: readonly string[];
  /** restic `--exclude` patterns, sorted. */
  excludes: readonly string[];
};

/**
 * The snapshot set a catalog implies. Every entry with `backup: true` contributes
 * its state directory, and its own excludes come with it — so a service joins the
 * backup by declaring that it has state worth restoring, and the script never
 * learns a service's name.
 *
 * Derived from the whole catalog rather than from the services a particular
 * `pulumi up` deploys: a staged deploy is a temporary state of the fleet, and a
 * backup set that shrank while DNS was brought up alone would be a backup
 * quietly covering less than the host holds. Paths that do not exist yet are
 * skipped by the script at run time.
 */
export function backupSet(specs: readonly ServiceSpec[]): BackupSet {
  const paths: string[] = [];
  const excludes: string[] = [];
  for (const spec of specs) {
    const path = backupPath(spec);
    if (path === null) {
      if ((spec.backupExclude ?? []).length > 0) {
        throw new Error(`${spec.name} excludes paths from a backup it is not part of`);
      }
      continue;
    }
    paths.push(path);
    for (const pattern of spec.backupExclude ?? []) {
      if (!pattern.startsWith(`${path}/`)) {
        throw new Error(`${spec.name} excludes ${pattern}, which is not under ${path}`);
      }
      excludes.push(pattern);
    }
  }
  return { paths: paths.sort(), excludes: excludes.sort() };
}

export type BackupConfigOptions = {
  target: BackupTarget;
  set: BackupSet;
  /** Digest-pinned restic image. */
  image: string;
};

/**
 * What the script reads. JSON rather than a shell fragment: it is parsed, never
 * sourced, so a share name is data and cannot become a command.
 *
 * Key order is fixed and both lists are sorted, because this file's content is a
 * resource input — an ordering that followed how the catalog happened to be
 * written would make an unrelated edit look like a change to the backup.
 */
export function renderBackupConfig(options: BackupConfigOptions): string {
  const { target, set, image } = options;
  return `${JSON.stringify(
    {
      host: target.host,
      share: target.share,
      mount: SHARE_MOUNTPOINT,
      mountOptions: target.mountOptions,
      repoDir: target.repoDir,
      cacheDir: RESTIC_CACHE_DIR,
      restoreDir: RESTORE_DIR,
      image,
      memoryMb: BACKUP_MEMORY_MB,
      tag: BACKUP_TAG,
      retention: RETENTION,
      groupBy: RETENTION_GROUP_BY,
      pruneMaxUnused: PRUNE_MAX_UNUSED,
      paths: set.paths,
      excludes: set.excludes,
    },
    null,
    2,
  )}\n`;
}

/**
 * The whole mechanism, in one file that takes `backup`, `prune`, or `run`
 * followed by restic's own arguments — the last being the manual path, where a
 * restore or a `snapshots` listing gets the same mount and the same unmount as a
 * scheduled run.
 *
 * Three properties are load-bearing and each has a line in here defending it:
 *
 * 1. **No credential reaches argv or the journal.** The mount options are a
 *    `mount(2)` argument; the repository password is handed to podman through
 *    the environment it inherits, named on the command line but never valued
 *    there. No exception message includes either.
 * 2. **The share is never left mounted.** The mount happens in the unit's own
 *    mount namespace (`PrivateMounts=yes`), so the kernel drops it when the run
 *    ends however it ends — and the script unmounts it in a `finally` anyway,
 *    with a lazy detach as the fallback and a stale mount cleared before it
 *    mounts.
 * 3. **A failure is loud.** Nothing is caught: an exception is a traceback and a
 *    non-zero exit, which is a failed unit — which is what the flight recorder
 *    writes to the ESP and what the selftest sees.
 */
export const BACKUP_SCRIPT = `#!/usr/bin/env python3
"""Snapshot this host's service state into the restic repository on the NAS.

Reads ${BACKUP_CONFIG_PATH} for what to back up and where, and
${BACKUP_SECRETS_PATH} for the credentials to do it with. Neither
restic nor mount.cifs has to exist on the host: the CIFS mount is the kernel's
own driver called through mount(2), and restic runs from a pinned container with
the repository and the backed-up paths bind-mounted into it.
"""

import ctypes
import ctypes.util
import json
import os
import signal
import socket
import subprocess
import sys

CONFIG = "${BACKUP_CONFIG_PATH}"
ENVIRONMENT = "${BACKUP_SECRETS_PATH}"

SMB_PORT = 445
MNT_DETACH = 2


def libc():
    """mount(2) and umount2(2), with argument types spelled out.

    ctypes would otherwise pass the flags word as a 32-bit int, leaving the top
    half of a 64-bit register to chance.
    """
    lib = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
    lib.mount.argtypes = [
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_ulong,
        ctypes.c_char_p,
    ]
    lib.mount.restype = ctypes.c_int
    lib.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
    lib.umount2.restype = ctypes.c_int
    return lib


def read_environment(path):
    """Parse KEY=VALUE lines. Parsed, not sourced: the file holds secrets, and
    sourcing it would also run whatever else it contained."""
    values = {}
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            values[name.strip()] = value
    return values


def is_mounted(target):
    with open("/proc/self/mounts") as handle:
        return any(len(f) > 1 and f[1] == target for f in (l.split(" ") for l in handle))


def unmount(lib, target):
    """Detach the share. A lazy unmount is the fallback, because leaving
    credentialed access to the NAS in place is worse than a busy mount."""
    if not is_mounted(target):
        return
    if lib.umount2(target.encode(), 0) == 0 and not is_mounted(target):
        return
    lib.umount2(target.encode(), MNT_DETACH)
    if is_mounted(target):
        raise RuntimeError("could not unmount " + target)


def mount_share(lib, config, environment):
    """Mount the share read-write, with the credentials as syscall bytes.

    The server's name is resolved here rather than in the kernel: userspace has
    the machine's whole resolver stack — /etc/hosts included, which is where
    keel-hosts.service writes an answer for a name the LAN's own DNS does not
    know — while the kernel has only its own upcall, and one of them is a
    dependency worth not having.
    """
    target = config["mount"]
    for name in ("SMB_USERNAME", "SMB_PASSWORD"):
        if not environment.get(name):
            raise RuntimeError(name + " is missing from " + ENVIRONMENT)
        if "," in environment[name]:
            # The kernel splits its option string on commas and offers no way to
            # escape one, so a credential containing a comma cannot be passed at
            # all. Saying so is better than mounting as some truncated user.
            raise RuntimeError(name + " contains a comma, which cifs options cannot carry")
    try:
        address = socket.getaddrinfo(config["host"], SMB_PORT, proto=socket.IPPROTO_TCP)[0][4][0]
    except OSError as error:
        # An address needs no resolver and never reaches this branch. A name
        # does, and the only thing that answers for one this LAN's own DNS does
        # not know is keel-hosts.service, which resolves it into /etc/hosts by
        # NetBIOS broadcast at boot and every five minutes — so a failure here
        # says that, rather than just repeating what getaddrinfo said.
        raise RuntimeError(
            "could not resolve "
            + config["host"]
            + ": "
            + str(error)
            + " — an address needs no resolver; a name is resolved into /etc/hosts by "
            + "keel-hosts.service, which answers a NetBIOS broadcast for it at boot and "
            + "every five minutes"
        ) from None
    source = "//" + config["host"] + "/" + config["share"]
    options = ",".join(
        [part for part in ["ip=" + address, config["mountOptions"]] if part]
        + ["user=" + environment["SMB_USERNAME"], "pass=" + environment["SMB_PASSWORD"]]
    )
    os.makedirs(target, mode=0o700, exist_ok=True)
    # A previous run killed outright could have left one behind. Mounting over it
    # would hide it rather than replace it.
    unmount(lib, target)
    if lib.mount(source.encode(), target.encode(), b"cifs", 0, options.encode()) != 0:
        code = ctypes.get_errno()
        # The message names the share and the errno, and never the options: this
        # string ends up in the journal.
        raise OSError(code, "mounting " + source + " failed: " + os.strerror(code))


def restic(config, environment, args, paths=(), writable=()):
    """Run restic in a container against the mounted repository.

    --network none: the repository is a directory on the mounted share, so
    nothing in a snapshot travels over a socket and the container needs no route.

    --security-opt label=disable: it reads /var/lib directories labelled for
    their own services and writes onto a CIFS mount, neither of which container_t
    may touch. It is a root one-shot from a digest-pinned image with nothing else
    in it.

    --memory: podman creates the container's cgroup itself and it may not be
    nested under this unit's, so the unit's MemoryMax alone would not cover it.
    Both come from the same figure.
    """
    repository = os.path.join(config["mount"], config["repoDir"])
    cache = config["cacheDir"]
    # restic stages pack files in TMPDIR before writing them; the default is a
    # tmpfs whose size is a fraction of a 1 GB board's RAM.
    os.makedirs(os.path.join(cache, "tmp"), mode=0o700, exist_ok=True)
    argv = [
        "podman",
        "run",
        "--rm",
        "--network",
        "none",
        "--security-opt",
        "label=disable",
        "--memory",
        str(config["memoryMb"]) + "m",
        # Named, not valued: podman reads the value out of its own environment.
        "--env",
        "RESTIC_PASSWORD",
        "--env",
        "RESTIC_CACHE_DIR=/cache",
        "--env",
        "TMPDIR=/cache/tmp",
        "--volume",
        repository + ":/repo:rw",
        "--volume",
        cache + ":/cache:rw",
    ]
    for path in paths:
        # Mounted at its own path, so the snapshot records where the data lives
        # and a restore can put it back there. Read-only: a backup has no reason
        # to be able to write to what it is reading, and a restore typed by hand
        # then cannot overwrite a running service's state.
        argv += ["--volume", path + ":" + path + ":ro"]
    for path in writable:
        argv += ["--volume", path + ":" + path + ":rw"]
    # The repository lock is the arbiter between a snapshot and a prune, and
    # arbitration means waiting: without this the loser fails the instant it
    # finds the lock, which is what two persistent timers firing together at
    # boot do. Bounded well inside the unit's own timeout.
    argv += [config["image"], "--repo", "/repo", "--retry-lock", "30m"] + list(args)
    child = dict(os.environ, RESTIC_PASSWORD=environment["RESTIC_PASSWORD"])
    subprocess.run(argv, env=child, check=True)


def do_backup(config, environment):
    paths = [path for path in config["paths"] if os.path.exists(path)]
    if not paths:
        # Every service that has state is undeployed, or the catalog is empty.
        # Either way an empty snapshot is not a success worth recording.
        raise RuntimeError("none of the configured paths exist")
    repository = os.path.join(config["mount"], config["repoDir"])
    if not os.path.exists(os.path.join(repository, "config")):
        os.makedirs(repository, exist_ok=True)
        restic(config, environment, ["init"])
    args = [
        "backup",
        # The container's host name is a random hex string, and restic stamps it
        # into the snapshot — which is also the key its retention groups on.
        "--host",
        socket.gethostname(),
        "--tag",
        config["tag"],
        "--exclude-caches",
    ]
    for pattern in config["excludes"]:
        args += ["--exclude", pattern]
    restic(config, environment, args + paths, paths)
    keep = config["retention"]
    restic(
        config,
        environment,
        [
            "forget",
            "--group-by",
            config["groupBy"],
            "--keep-daily",
            str(keep["daily"]),
            "--keep-weekly",
            str(keep["weekly"]),
            "--keep-monthly",
            str(keep["monthly"]),
        ],
    )


def do_prune(config, environment):
    restic(config, environment, ["prune", "--max-unused", config["pruneMaxUnused"]])
    # A repository that cannot be read is not a backup. A subset each week costs
    # little and eventually covers everything.
    restic(config, environment, ["check", "--read-data-subset=5%"])


def do_run(config, environment, args):
    """Hand the arguments to restic against the mounted repository.

    This is the whole of the manual path: snapshots, ls, dump, find, and the
    restore itself. Restores are deliberately not automatic, and they are
    deliberately awkward in one direction only — the backed-up paths are
    read-only here exactly as they are for a scheduled run, so a restore writes
    into the staging directory and the operator moves what they came for.
    """
    if not args:
        raise RuntimeError("run needs at least one restic argument")
    os.makedirs(config["restoreDir"], mode=0o700, exist_ok=True)
    paths = [path for path in config["paths"] if os.path.exists(path)]
    restic(config, environment, args, paths, (config["restoreDir"],))


def main(argv):
    if len(argv) < 2 or argv[1] not in ("backup", "prune", "run"):
        print("usage: backup.py backup|prune|run <restic argument>...", file=sys.stderr)
        return 2
    if argv[1] != "run" and len(argv) != 2:
        print(argv[1] + " takes no arguments", file=sys.stderr)
        return 2
    with open(CONFIG) as handle:
        config = json.load(handle)
    environment = read_environment(ENVIRONMENT)
    if not environment.get("RESTIC_PASSWORD"):
        raise RuntimeError("RESTIC_PASSWORD is missing from " + ENVIRONMENT)
    # systemd's timeout arrives as a signal, and the unmount below has to happen
    # on the way out. Raising SystemExit from the handler unwinds through the
    # finally; the default disposition would not.
    for received in (signal.SIGTERM, signal.SIGINT):
        signal.signal(received, lambda *_: sys.exit("keel-backup: terminated"))
    lib = libc()
    mount_share(lib, config, environment)
    try:
        if argv[1] == "backup":
            do_backup(config, environment)
        elif argv[1] == "prune":
            do_prune(config, environment)
        else:
            do_run(config, environment, argv[2:])
    finally:
        unmount(lib, config["mount"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;

/**
 * `PrivateMounts=yes` is the guarantee that outlives the script's own `finally`:
 * the share is mounted in this unit's namespace, so a `SIGKILL` — or anything
 * else that skips the cleanup — takes the mount with it.
 *
 * The unit is deliberately in no keel slice. `keel-core` is protected from
 * reclaim and `keel-apps` is throttled against a budget the running services
 * were priced into; a nightly one-shot belongs to neither, and its cap is stated
 * here because there is no profile drop-in for something that is not a service.
 */
function oneShot(
  description: string,
  argument: string,
  timeout: string,
  extra: readonly string[],
): string {
  return [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target keel-secrets.service",
    "Wants=network-online.target",
    ...extra,
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=/usr/bin/python3 ${BACKUP_SCRIPT_PATH} ${argument}`,
    `MemoryMax=${BACKUP_MEMORY_MB}M`,
    "Nice=15",
    "IOSchedulingClass=idle",
    `TimeoutStartSec=${timeout}`,
    "PrivateMounts=yes",
    "",
  ].join("\n");
}

export function backupService(): string {
  return oneShot("Restic snapshot of service state to the NAS share", "backup", "2h", []);
}

/**
 * Prune and snapshot both take restic's repository lock, and restic is the
 * arbiter: whichever loses the race waits for the lock (`--retry-lock` in the
 * script), and only a wait longer than that fails loudly for its own timer to
 * bring it back at the next window. No `Conflicts=` here — systemd's conflict
 * semantics STOP the running unit when the other starts, which would kill an
 * in-flight snapshot to make room for housekeeping.
 */
export function pruneService(): string {
  return oneShot("Restic prune of the NAS repository", "prune", "4h", []);
}

function timer(description: string, schedule: string): string {
  return dedent(`
    [Unit]
    Description=${description}
    # A board with no real-time clock boots at the image's build date and is
    # stepped forward by weeks once NTP answers. A persistent timer loaded before
    # the step discards its stamp as "in the future" and then treats every
    # calendar elapse inside the jump as missed — a run on every boot. The image
    # holds time-sync.target until chrony is synchronised (chrony-wait, 180 s at
    # most), and this line is what makes the timer wait for it.
    After=time-sync.target

    [Timer]
    OnCalendar=${schedule}
    RandomizedDelaySec=${RANDOMIZED_DELAY}
    # A board that was off at the scheduled minute runs the missed window at the
    # next boot instead of skipping it.
    Persistent=true

    [Install]
    WantedBy=timers.target
  `);
}

export function backupTimer(): string {
  return timer("Daily restic snapshot", BACKUP_SCHEDULE);
}

export function pruneTimer(): string {
  return timer("Weekly restic prune", PRUNE_SCHEDULE);
}
