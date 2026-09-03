/**
 * A service's certificate, kept in step with the proxy's.
 *
 * Some services terminate TLS themselves — they have no plaintext listener — so
 * they need the same wildcard the proxy obtains over DNS-01, in files of their
 * own. The proxy keeps every certificate it holds in one store, which is a store
 * rather than an interface: nothing else can read a certificate out of it, and
 * there is no hook to run when one is renewed.
 *
 * So a one-shot extracts the wildcard into the directory the service declared, a
 * path unit runs it whenever the store changes, and the service's quadlet pulls
 * the one-shot in on every start. Renewals reach the service without anyone
 * watching the calendar, and a first deploy is not a race between the two.
 *
 * The one-shot **waits** for the certificate rather than reporting its absence,
 * which is what makes the first deploy of a fresh host one command. The proxy
 * starts answering in seconds and its DNS-01 challenge completes in minutes, so a
 * reader that merely looked would find an empty store, start anyway and die on
 * its own missing file. The wait is bounded by the store's `settleSeconds`, and
 * the unit's start timeout is set from it — a certificate that is never going to
 * arrive fails this unit by name, and the service that needs it fails after.
 *
 * Both halves are declarations rather than names: the proxy's role says what the
 * store is and how to read it, the consumer's entry says where the files go, and
 * this derives the pair from those two. Nothing here is keyed on a service being
 * called kanidm.
 *
 * These are host-level units rather than image content because their existence
 * follows a service Pulumi deploys: the image owns `/usr/lib`, this owns `/etc`.
 * Everything under `/usr` — `/usr/local` included — is sealed read-only on this
 * image, so the program lives beside the certificates it writes. It is data to
 * the unit, not an executable: `ExecStart` names the interpreter and passes the
 * program as an argument, which also keeps SELinux out of it (init executes
 * `bin_t` python, and only *reads* the `etc_t` file).
 */

import { createHash } from "node:crypto";

import * as pulumi from "@pulumi/pulumi";

import { certSyncName, type ProxyRole, type ServiceSpec } from "../config/spec";
import { RemoteFile } from "./providers/remoteFile";
import { SystemdUnit } from "./providers/systemdUnit";

/**
 * The type token, which is part of the URN of every resource beneath this
 * component — state identity rather than a description. It names the first
 * consumer because that is what the running stack recorded: changing it makes
 * Pulumi replace the files and the unit under it on a host that is already
 * serving the LAN, so moving it is an `aliases` entry and a migration of its own
 * rather than a rename.
 */
const TYPE = "keel:index:KanidmCertSync";

/** The three bodies the pair is written from, and where the program lands. */
export type CertSyncBodies = {
  /** The unit pair's base name, after the service whose certificate it is. */
  name: string;
  script: { path: string; content: string };
  /** The one-shot that runs the program. */
  service: string;
  /** The path unit that re-runs the one-shot when the store changes. */
  pathUnit: string;
};

/**
 * One store and one consumer, as the three files that connect them.
 *
 * `PathChanged` fires on a close-after-write, which is what a renewal looks like
 * — and, unlike `PathExists`, does not re-trigger for as long as the file is
 * there. The first sync does not come from the path unit: the consumer wants the
 * one-shot, so starting the service runs it.
 */
export function certSyncBodies(proxy: ProxyRole, consumer: ServiceSpec): CertSyncBodies {
  const name = certSyncName(consumer);
  const dir = consumer.certificates?.dir;
  if (name === null || dir === undefined) {
    throw new Error(`${consumer.name} declares no certificate directory to sync into`);
  }
  const store = proxy.certificateStore;
  if (store === undefined) {
    throw new Error(`${consumer.name} needs a certificate and the proxy keeps no store`);
  }

  // Beside the certificate directory, in the consumer's own /etc tree: /usr is
  // read-only on this image, and the service already mounts what is here.
  const scriptPath = `${dir.replace(/\/[^/]+$/, "")}/cert-sync.py`;

  // Longer than the program's own deadline, so a store that never fills fails
  // with the program's sentence in the journal rather than with systemd's kill.
  const timeout = store.settleSeconds + 30;

  return {
    name,
    script: {
      path: scriptPath,
      content: store.extract({ dir, journalTag: name, settleSeconds: store.settleSeconds }),
    },
    // Ordered after the service that fills the store, and run through the named
    // interpreter rather than the program's own shebang.
    service: `[Unit]
Description=Sync ${store.product}'s wildcard certificate into ${dir}
After=${proxy.unit}

[Service]
Type=oneshot
TimeoutStartSec=${timeout}
ExecStart=${store.interpreter} ${scriptPath}
`,
    pathUnit: `[Unit]
Description=Re-sync ${consumer.name}'s certificate when ${store.product} renews it

[Path]
PathChanged=${store.path}

[Install]
WantedBy=multi-user.target
`,
  };
}

export type CertSyncArgs = {
  /** ssh_config alias of the host that runs it. */
  host: string;
  /** The role that owns the store, for the file to read and the unit to follow. */
  proxy: ProxyRole;
  /** The entry that declared the certificates, which the pair is named after. */
  consumer: ServiceSpec;
  /** Extra ssh arguments, for reaching a host that is not in the real ssh_config. */
  sshArgs?: readonly string[];
};

export default class CertSync extends pulumi.ComponentResource {
  public readonly unit: SystemdUnit;

  constructor(args: CertSyncArgs, opts?: pulumi.ComponentResourceOptions) {
    const { host, proxy, consumer, sshArgs } = args;
    const bodies = certSyncBodies(proxy, consumer);
    const name = bodies.name;
    super(TYPE, name, {}, opts);
    const parent = { parent: this };

    const script = new RemoteFile(
      `${name}-script`,
      { host, sshArgs, path: bodies.script.path, content: bodies.script.content, mode: "644" },
      parent,
    );
    const service = new RemoteFile(
      `${name}-service`,
      {
        host,
        sshArgs,
        path: `/etc/systemd/system/${name}.service`,
        content: bodies.service,
        mode: "644",
      },
      parent,
    );
    const path = new RemoteFile(
      `${name}-path`,
      {
        host,
        sshArgs,
        path: `/etc/systemd/system/${name}.path`,
        content: bodies.pathUnit,
        mode: "644",
      },
      parent,
    );

    // The path unit is the one with runtime state: enabling it starts the watch,
    // and deleting this resource stops it. The one-shot it triggers is a unit
    // file and nothing more — a completed one-shot is inactive, which is its
    // success, so there is no state here worth reading back.
    this.unit = new SystemdUnit(
      name,
      {
        host,
        sshArgs,
        unit: `${name}.path`,
        quadlet: false,
        trigger: createHash("sha256")
          .update([bodies.script.content, bodies.service, bodies.pathUnit].join("\n"))
          .digest("hex"),
      },
      { ...parent, dependsOn: [script, service, path] },
    );

    this.registerOutputs({});
  }
}
