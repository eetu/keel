/**
 * Backup policy — retention, schedule and the tool image, for every host that
 * states `backup: true`.
 *
 * Committed, because none of it names an installation: which share the repository
 * sits on is in `installation.ts`, and the password that opens it is in the vault. What is
 * here is the shape of the backup itself, and it is the same on every board.
 */

import { type SecretRef } from "./spec";

/**
 * Restic, as a container. The board runs one image for its whole OS and that
 * image gains `restic` and `cifs-utils` from the next build onwards — but a
 * package cannot reach a board that is already running, and the fleet's data is
 * unprotected until the backup works on the image the board booted. So the
 * snapshot is taken by a pinned container, which podman can pull today.
 *
 * It stays the mechanism after the packages land: it is the same restic version
 * on every host regardless of when each was last updated, and a backup that
 * depends on nothing in `/usr` cannot be broken by an image that changes it.
 *
 * 0.19.1. Resolve with `scripts/pin-image.sh`.
 */
export const RESTIC_IMAGE =
  "docker.io/restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510";

/**
 * How many snapshots survive `restic forget`, carried over unchanged from the
 * pyinfra repo — the same repository is being written to, and a retention that
 * disagreed with what is already in it would drop history nobody decided to drop.
 */
export const RETENTION = { daily: 7, weekly: 4, monthly: 6 } as const;

/**
 * How `restic forget` groups snapshots before applying the window above. Stated
 * explicitly because the choice is consequential in both directions and the
 * default is the safe one.
 *
 * `host,paths` — restic's default — gives each path set its own window. Changing
 * the backup set therefore starts a *new* group, and the old group's snapshots
 * stop being considered by any future retention run: they are never forgotten,
 * and the repository grows by one stale ladder per change. That is visible, slow
 * and fixable by hand.
 *
 * `host` is the tempting alternative — one window per machine, self-cleaning
 * across path-set changes — and it is a footgun on a repository with history in
 * it. Every snapshot the machine ever took lands in one group, so the first run
 * forgets everything outside a single 7/4/6 ladder. On this fleet's repository
 * that is 53 of 66 snapshots, spanning a year, deleted by one run of a unit
 * nobody was watching. `forget` only unlinks — the data survives until a prune
 * — but the restore points do not come back.
 */
export const RETENTION_GROUP_BY = "host,paths";

/** Tag on every scheduled snapshot, so a hand-made one is distinguishable. */
export const BACKUP_TAG = "scheduled";

/**
 * Daily, in the small hours, jittered so a fleet does not hit the share in the
 * same minute. `Persistent=true` runs a missed window at the next boot — a board
 * that was off at 04:00 still gets its snapshot.
 */
export const BACKUP_SCHEDULE = "*-*-* 04:00:00";

/**
 * Prune is separate and weekly: it rewrites pack files, holds the repository
 * lock for the duration and is the memory-hungry half of restic. `--max-unused`
 * caps how much it tries to reclaim in one run so a 1 GB board finishes it.
 */
export const PRUNE_SCHEDULE = "Sun *-*-* 04:30:00";
export const PRUNE_MAX_UNUSED = "100M";

/** Jitter on both timers. */
export const RANDOMIZED_DELAY = "30m";

/**
 * Hard cap on a backup run, MiB. Not a profile number: this is a one-shot that
 * runs while the board is otherwise idle, and it is deliberately not in
 * `keel-apps.slice` — a snapshot is not a service, and throttling it against the
 * services would make the tier's budget describe something that is not running
 * most of the time. The figure is what the pyinfra repo proved sufficient on the
 * 1 GB board.
 */
export const BACKUP_MEMORY_MB = 384;

/**
 * Restic's cache, machine-local and reclaimable — under `/var/cache`, not the
 * `/root/.cache` default. It holds the repository index, which restic rebuilds
 * from the repository whenever it is missing.
 */
export const RESTIC_CACHE_DIR = "/var/cache/restic";

/**
 * Where the share is mounted for the duration of a run. Under `/run`, so it is a
 * tmpfs directory that cannot survive a reboot, and mode 700: credentialed
 * access to the NAS is not something to leave lying around the filesystem.
 */
export const SHARE_MOUNTPOINT = "/run/keel-backup/share";

/**
 * Where a hand-run restore writes. The backed-up paths are mounted read-only for
 * every run, so nothing restic is asked to do by hand can overwrite live service
 * state — a restore lands here and the operator moves what they wanted. That is
 * the whole of the restore story for now: the pyinfra repo's restore-on-blank,
 * which prompted at plan time and wrote straight into `/`, is deliberately not
 * carried over.
 */
export const RESTORE_DIR = "/var/tmp/keel-restore";

/**
 * The credentials a run needs, as vault field names — read at deploy time,
 * sealed for the host and never an input to anything.
 *
 * Both items predate this repo. The repository password is the `restic` login
 * item's password field, which is the one value that must never be lost: without
 * it every snapshot in the repository is unreadable. The share's login is the
 * `cifs` item's read-write pair, the same account the pyinfra repo mounts every
 * writable share with.
 */
export const BACKUP_VAULT_ITEM = "restic";

export const BACKUP_SECRET_ENV: Record<string, SecretRef> = {
  RESTIC_PASSWORD: "password",
  SMB_USERNAME: { item: "cifs", field: "readwrite_username" },
  SMB_PASSWORD: { item: "cifs", field: "readwrite_password" },
};
