/**
 * A CIFS share, as resources on a device.
 *
 * No new mechanism in any of them: the sealed login travels the `SealedEnv` +
 * `SecretFile` path a service's environment does — a credentials file is
 * `username=…` / `password=…`, which is exactly the body an env file is — and the
 * `.mount` unit points at the decrypted path rather than carrying the login. So
 * the state file holds ciphertext it cannot open, the unit body holds no
 * credential, and nothing reaches `argv` or the journal.
 *
 * Why Pulumi's and not the image's: a mount exists because a service the deploy
 * layer installs binds a path under it. An image would have to be rebuilt and a
 * board rebooted to give a new app its data.
 *
 * The `SystemdUnit` is what carries runtime state, and for a mount unit the two
 * ends line up exactly: `enable --now` mounts the share, and the `delete` that
 * follows a removed declaration disables it — which unmounts it.
 *
 * One thing this needs from the machine that the backup deliberately does not:
 * `mount.cifs`. `credentials=` is the helper's option, not the kernel's, and
 * without the helper the option is not rejected but ignored — so a probe for it
 * is ordered ahead of the unit. That is the trade: the
 * backup borrows nothing and passes its own option bytes to `mount(2)`, while a
 * share a service depends on is worth a real unit, and a unit cannot read a
 * credentials file by itself.
 */

import { createHash } from "node:crypto";

import * as pulumi from "@pulumi/pulumi";

import { SHARE_CREDENTIAL_FIELDS, SHARE_VAULT_ITEM } from "../config/shares";
import { MOUNT_HELPER, type MountedShare, mountUnit } from "../render/mount";
import { RemoteBinary } from "./providers/remoteBinary";
import { RemoteFile } from "./providers/remoteFile";
import { SealedEnv } from "./providers/sealedEnv";
import { SecretFile } from "./providers/secretFile";
import { SystemdUnit } from "./providers/systemdUnit";
import { assertSafePath, assertSafeUnit } from "./ssh";

export type CifsMountArgs = {
  /** ssh_config alias of the host that mounts it. */
  host: string;
  /** The share and everything derived from it, from `mountedShares`. */
  mount: MountedShare;
  /** The vault holding the two NAS logins. */
  vault: string;
  /** Public half of the age identity on the target host. */
  ageRecipient: string;
  /** Extra ssh arguments, for reaching a host that is not in the real ssh_config. */
  sshArgs?: readonly string[];
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export default class CifsMount extends pulumi.ComponentResource {
  public readonly unit: SystemdUnit;

  constructor(args: CifsMountArgs, opts?: pulumi.ComponentResourceOptions) {
    const { host, mount, vault, ageRecipient, sshArgs } = args;
    // The transport's own guards, and by here they hold: ssh joins its arguments
    // and the remote shell re-parses them, so neither a unit name nor a path may
    // carry shell syntax — systemd's `\xNN` escapes included. `assertShare`
    // refuses the mountpoint that would produce one at plan time, where the error
    // says which character to rename; these two are what make that a property of
    // everything reaching a device rather than of one caller.
    assertSafeUnit(mount.unit);
    assertSafePath(mount.credentials);
    const name = mount.unit.replace(/\.mount$/, "");
    super("keel:index:CifsMount", name, {}, opts);
    const parent = { parent: this };

    // The pair follows from the share's own `readOnly`, which is what keeps a
    // read-only share from holding an account that can write to the NAS.
    const sealed = new SealedEnv(
      `${name}-credentials`,
      {
        vault,
        item: SHARE_VAULT_ITEM,
        fields: { ...SHARE_CREDENTIAL_FIELDS[mount.share.readOnly ? "readOnly" : "readWrite"] },
        ageRecipient,
      },
      parent,
    );
    const secret = new SecretFile(
      `${name}-secret`,
      {
        host,
        sshArgs,
        path: `${mount.credentials}.age`,
        ciphertext: sealed.ciphertext,
        plaintextHash: sealed.plaintextHash,
      },
      parent,
    );

    // Asked before the unit is handed to systemd, because the failure it prevents
    // is not a failure: without the helper the kernel takes the option list
    // itself, ignores `credentials=`, and mounts the share unauthenticated
    // wherever the server allows a guest.
    const helper = new RemoteBinary(
      `${name}-helper`,
      {
        host,
        sshArgs,
        path: MOUNT_HELPER,
        installedBy: "cifs-utils",
        neededBy: `the ${mount.unit} unit`,
      },
      parent,
    );

    const body = mountUnit(mount.share);
    const unitFile = new RemoteFile(
      `${name}-unit`,
      { host, sshArgs, path: `/etc/systemd/system/${mount.unit}`, content: body, mode: "644" },
      parent,
    );

    // The helper and the credentials before the mount: one is what reads the
    // other, and a mount that starts without either is a mount with no login.
    // The trigger folds the credentials' hash in for the same reason the backup's
    // does — a rotated NAS login has to reach the mount rather than wait in a
    // file for the next reboot.
    this.unit = new SystemdUnit(
      name,
      {
        host,
        sshArgs,
        unit: mount.unit,
        quadlet: false,
        trigger: pulumi
          .output(sealed.plaintextHash)
          .apply((secretHash) => sha256([body, secretHash].map(sha256).join(""))),
      },
      { ...parent, dependsOn: [helper, secret, unitFile] },
    );

    this.registerOutputs({});
  }
}
