/**
 * The backup, as resources on a device.
 *
 * Six files and two timers: the script, the config it reads, and a
 * service/timer pair each for the nightly snapshot and the weekly prune. The
 * sealed credentials come from the same `SealedEnv` + `SecretFile` path a
 * service's environment does, so the restic password and the share's login are
 * ciphertext in state and plaintext only on the host.
 *
 * Why this is Pulumi's and not the image's: the snapshot set is derived from the
 * services the catalog says have state, which is a thing that changes with every
 * app that lands. An image would have to be rebuilt and a board rebooted to add
 * a directory to a backup.
 *
 * The timers are what carry runtime state, so they are the `SystemdUnit`
 * resources — enabling one starts the clock, and deleting it stops it. The
 * one-shots they trigger are unit files and nothing more: a completed one-shot
 * is inactive, which is its success, so there is nothing there to read back.
 */

import { createHash } from "node:crypto";

import * as pulumi from "@pulumi/pulumi";

import {
  BACKUP_CONFIG_PATH,
  BACKUP_SCRIPT,
  BACKUP_SCRIPT_PATH,
  BACKUP_UNIT,
  backupService,
  backupTimer,
  PRUNE_UNIT,
  pruneService,
  pruneTimer,
} from "../render/backup";
import { RemoteFile } from "./providers/remoteFile";
import { SecretFile } from "./providers/secretFile";
import { SystemdUnit } from "./providers/systemdUnit";

export type KeelBackupArgs = {
  /** ssh_config alias of the host that runs it. */
  host: string;
  /** The config file's body, from `renderBackupConfig`. */
  config: string;
  /**
   * Sealed `RESTIC_PASSWORD`, `SMB_USERNAME` and `SMB_PASSWORD`, and the hash of
   * their plaintext. Ciphertext and a hash only — the same rule every secret in
   * this repo follows, and the reason a rotation is visible as a trigger change
   * rather than as a diff of the value.
   */
  sealedEnv: { ciphertext: pulumi.Input<string>; plaintextHash: pulumi.Input<string> };
  /** Where the decrypted env file lands, from `BACKUP_SECRETS_PATH`. */
  secretsPath: string;
  /** Extra ssh arguments, for reaching a host that is not in the real ssh_config. */
  sshArgs?: readonly string[];
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export default class KeelBackup extends pulumi.ComponentResource {
  public readonly backup: SystemdUnit;
  public readonly prune: SystemdUnit;

  constructor(name: string, args: KeelBackupArgs, opts?: pulumi.ComponentResourceOptions) {
    const { host, config, sealedEnv, secretsPath, sshArgs } = args;
    super("keel:index:KeelBackup", name, {}, opts);
    const parent = { parent: this };

    const script = new RemoteFile(
      `${name}-script`,
      { host, sshArgs, path: BACKUP_SCRIPT_PATH, content: BACKUP_SCRIPT, mode: "644" },
      parent,
    );
    // 600: it names the share and the repository directory. Not a secret, but
    // nothing but root has a reason to read it either.
    const configFile = new RemoteFile(
      `${name}-config`,
      { host, sshArgs, path: BACKUP_CONFIG_PATH, content: config, mode: "600" },
      parent,
    );
    const secret = new SecretFile(
      `${name}-secret`,
      { host, sshArgs, path: `${secretsPath}.age`, ...sealedEnv },
      parent,
    );

    const units = [
      { unit: BACKUP_UNIT, service: backupService(), timer: backupTimer() },
      { unit: PRUNE_UNIT, service: pruneService(), timer: pruneTimer() },
    ] as const;

    const enabled = units.map(({ unit, service, timer }) => {
      const serviceFile = new RemoteFile(
        `${unit}-service`,
        {
          host,
          sshArgs,
          path: `/etc/systemd/system/${unit}.service`,
          content: service,
          mode: "644",
        },
        parent,
      );
      const timerFile = new RemoteFile(
        `${unit}-timer`,
        { host, sshArgs, path: `/etc/systemd/system/${unit}.timer`, content: timer, mode: "644" },
        parent,
      );
      // The trigger folds in the script and the config as well as the units:
      // changing what a run does has to reach the enabled timer, or the new
      // script would sit on disk until something else happened to restart it.
      // The secret's hash is in there for the same reason — a rotated password
      // is a run that would otherwise fail at 04:00 with nobody watching.
      return new SystemdUnit(
        unit,
        {
          host,
          sshArgs,
          unit: `${unit}.timer`,
          quadlet: false,
          trigger: pulumi
            .output(sealedEnv.plaintextHash)
            .apply((secretHash) =>
              sha256([BACKUP_SCRIPT, config, service, timer, secretHash].map(sha256).join("")),
            ),
        },
        { ...parent, dependsOn: [script, configFile, secret, serviceFile, timerFile] },
      );
    });

    this.backup = enabled[0];
    this.prune = enabled[1];

    this.registerOutputs({});
  }
}
