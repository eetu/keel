/**
 * The nightly snapshot, as a set of rules rather than a set of lines.
 *
 * None of these bodies is in a golden: the units, the script and its
 * configuration are written to a host that states `backup: true`, and a fixture
 * host does not. So what is held here is what would fail at 04:00 with nobody
 * watching — a path list that drifted from the catalog, a retention window that
 * forgot a year, a credential in the process table, a share left mounted.
 */

import { describe, expect, it } from "vitest";

import { BACKUP_SECRET_ENV, RESTIC_IMAGE, RETENTION_GROUP_BY } from "../src/config/backup";
import { SERVICES } from "../src/config/services";
import { backupPath, type ServiceSpec } from "../src/config/spec";
import { type BackupTarget } from "../src/config/types";
import {
  BACKUP_CONFIG_PATH,
  BACKUP_SCRIPT,
  BACKUP_SECRET_VARS,
  BACKUP_SECRETS_PATH,
  backupService,
  backupSet,
  pruneService,
  renderBackupConfig,
} from "../src/render/backup";
import { renderNftForward } from "../src/render/nftForward";
import { NETWORK_INTERFACES } from "../src/render/quadlet";

/** Stand-in for `INSTALLATION.backup`: the renderers must never read the real one. */
const TARGET: BackupTarget = {
  host: "nas.invalid",
  share: "backups",
  repoDir: "fleet-restic",
  mountOptions: "vers=3.1.1,sec=ntlmsspi",
};

const config = (): Record<string, unknown> =>
  JSON.parse(renderBackupConfig({ target: TARGET, set: backupSet(SERVICES), image: RESTIC_IMAGE }));

/** A fixture entry, so a rule is asserted on a declaration and not on a house. */
const excluding = (name: string, backup: boolean, pattern: string): ServiceSpec => ({
  name,
  description: "fixture",
  image: "x@sha256:0",
  port: 1,
  memory: { max: 32, tier: "apps" },
  auth: "open",
  backup,
  backupExclude: [pattern],
});

describe("the snapshot set derives from the catalog", () => {
  it("covers every service that declares state and nothing else, in a stable order", () => {
    // A service is in the backup because its entry says it has state, not
    // because a path list was edited too; and the set is sorted, so an edit to
    // the catalog's order is not a change to the backup.
    const { paths, excludes } = backupSet(SERVICES);
    expect(paths).toEqual(
      SERVICES.map(backupPath)
        .filter((path): path is string => path !== null)
        .sort(),
    );
    for (const spec of SERVICES) {
      expect(paths.includes(`/var/lib/${spec.name}`), spec.name).toBe(spec.backup === true);
      for (const pattern of spec.backupExclude ?? []) expect(excludes).toContain(pattern);
    }
    expect(backupSet([...SERVICES].reverse())).toEqual(backupSet(SERVICES));
  });

  it("refuses an exclude that belongs to no snapshot", () => {
    // An exclude is a statement about a path in the set; outside it, it
    // excludes nothing and hides the mistake.
    expect(() => backupSet([excluding("orphan", false, "/var/lib/orphan/cache")])).toThrow(
      /not part of/,
    );
    expect(() => backupSet([excluding("wide", true, "/var/lib/other/cache")])).toThrow(/not under/);
  });
});

describe("the script", () => {
  it("reads its configuration and its credentials from the paths the units promise", () => {
    // The decrypted counterpart of the blob `keel-secrets.service` opens, and the
    // three variable names the deploy layer seals: a mismatch in either is a
    // backup that fails at 04:00 with nobody watching.
    expect(BACKUP_SCRIPT).toContain(`CONFIG = "${BACKUP_CONFIG_PATH}"`);
    expect(BACKUP_SCRIPT).toContain(`ENVIRONMENT = "${BACKUP_SECRETS_PATH}"`);
    expect(BACKUP_SECRETS_PATH.startsWith("/etc/secrets/")).toBe(true);
    expect([...BACKUP_SECRET_VARS].sort()).toEqual(Object.keys(BACKUP_SECRET_ENV).sort());
    for (const name of BACKUP_SECRET_VARS) expect(BACKUP_SCRIPT).toContain(name);
  });

  it("keeps retention inside one path set, so no run can forget another's history", () => {
    // `--group-by host` would put every snapshot the machine ever took into one
    // window: the first run forgets a year of restore points, and this
    // repository already holds a year.
    expect(config().groupBy).toBe("host,paths");
    expect(RETENTION_GROUP_BY).not.toBe("host");
    expect(BACKUP_SCRIPT).toContain('"--group-by"');
  });

  it("puts no credential in argv", () => {
    // The mount options are a syscall argument and the repository password is
    // inherited through podman's environment — named on the command line, never
    // valued there. `-o` or `--env NAME=value` here would be a password in the
    // process table.
    expect(BACKUP_SCRIPT).toContain("lib.mount(");
    expect(BACKUP_SCRIPT).toContain('"--env",\n        "RESTIC_PASSWORD",');
    expect(BACKUP_SCRIPT).not.toContain('"RESTIC_PASSWORD=');
    expect(BACKUP_SCRIPT).toContain("RESTIC_PASSWORD=environment[");
    expect(BACKUP_SCRIPT).not.toContain("mount -");
  });

  it("never leaves the share mounted", () => {
    // Three layers: the unit's private namespace, the finally, and a lazy
    // detach when a plain unmount says the share is busy.
    expect(BACKUP_SCRIPT).toContain("finally:");
    expect(BACKUP_SCRIPT).toContain('unmount(lib, config["mount"])');
    expect(BACKUP_SCRIPT).toContain("MNT_DETACH");
    expect(backupService()).toContain("PrivateMounts=yes");
    expect(pruneService()).toContain("PrivateMounts=yes");
  });

  it("names no installation; the configuration file does", () => {
    // The script is generic: every value that belongs to one network arrives
    // through the file, and a pinned restic writes every snapshot.
    const rendered = config();
    expect(rendered.host).toBe(TARGET.host);
    expect(rendered.share).toBe(TARGET.share);
    expect(rendered.repoDir).toBe(TARGET.repoDir);
    for (const value of [TARGET.host, TARGET.share, TARGET.repoDir]) {
      expect(BACKUP_SCRIPT).not.toContain(value);
    }
    for (const [label, pattern] of [
      ["RFC1918 address", /\b(10|192\.168)\.\d{1,3}\.\d{1,3}\.?\d{0,3}\b/],
      ["a host from the fleet", /\brasp[io]\b/i],
      ["an SMB URL", /\/\/[a-z0-9]/i],
    ] as const) {
      expect(BACKUP_SCRIPT, label).not.toMatch(pattern);
    }
    expect(RESTIC_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});

describe("the open bridge's forward rule", () => {
  it("re-declares the chain's hook, names the open bridge alone, and is a file even when empty", () => {
    // A bare `chain forward { … }` on a board whose image predates the chain
    // would create a regular chain — installed, listed, and never called. And
    // withdrawing the rule is an update of this file, never its deletion:
    // deletions run after the reload, so an absent file is one the reload still
    // reads, and it would re-install the accept it was run to withdraw.
    const rules = renderNftForward(true);
    expect(rules).toContain("table inet keel {");
    expect(rules).toContain("type filter hook forward priority filter; policy drop;");
    expect(rules).toContain(`iifname "${NETWORK_INTERFACES.open}" accept`);
    expect(rules).not.toContain(NETWORK_INTERFACES.internal);
    const none = renderNftForward(false);
    expect(none).not.toContain("iifname");
    expect(none).toMatch(/^#/);
  });
});
