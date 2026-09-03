/**
 * One service, declared once.
 *
 * A `Service` fans a single `ServiceSpec` out into every resource that service
 * needs: the quadlet, its memory caps, the systemd unit that runs it, and the
 * route file the proxy serves it on. The ports the packet filter admits to it
 * are published rather than written, because that file belongs to the host
 * rather than to any one service. The seams for the resources that need their
 * own providers — the DNS record, the OIDC client the identity provider
 * registers — are marked below and land with those providers.
 *
 * This is the part that stops being a per-service task file. Under pyinfra the
 * same service was spread across `tasks/<svc>.py`, a `ROUTES` tuple in
 * `tasks/traefik.py`, a name in `_SUBDOMAIN_NAMES`, an entry in `RESTRICTED`, a
 * block in `tasks/secrets.py` and a path in `RESTIC["paths"]`, with a cleanup
 * branch in the task to undo it. Here those are derived, and deletion is the
 * absence of a declaration.
 */

import { createHash } from "node:crypto";

import * as pulumi from "@pulumi/pulumi";

import { INSTALLATION } from "../config/installation";
import { selectProfile } from "../config/profiles";
import { backupPath, type Catalog, secretsPath, type ServiceSpec } from "../config/spec";
import { type ServiceFile } from "../config/types";
import { memoryDropInPath, serviceDropIn } from "../render/memory";
import { quadletPath, renderQuadlet } from "../render/quadlet";
import { RemoteFile } from "./providers/remoteFile";
import { SecretFile } from "./providers/secretFile";
import { SystemdUnit } from "./providers/systemdUnit";

export type ServiceArgs = {
  /** ssh_config alias of the host that runs it. */
  host: string;
  spec: ServiceSpec;
  /**
   * The board's RAM, MiB. It selects the memory profile this service's caps come
   * from — the deploy layer knows which board it is deploying to, so the caps
   * are written with the quadlet rather than staged in the image for every
   * board at once.
   */
  ramMb: number;
  /**
   * What to run, digest-pinned. An `Output` when a rolling tag had to be
   * resolved by `ImageDigest`, whose answer exists only once that resource has
   * run — so a preview of a rolling service shows the tag it will resolve.
   */
  image: pulumi.Input<string>;
  /**
   * Env-file body and its plaintext hash, sealed for this host by `SealedEnv`.
   * Ciphertext and a hash only: encryption must not happen inside a provider
   * that could capture the plaintext, and the plaintext is never an input.
   */
  sealedEnv?: { ciphertext: pulumi.Input<string>; plaintextHash: pulumi.Input<string> };
  /**
   * Environment the entry's own `setup` composed from the installation — an
   * issuer URL, a cookie domain. It reaches the quadlet as ordinary
   * `Environment=` lines, so it is part of the body the restart trigger hashes:
   * changing the zone restarts the services that name it.
   */
  extraEnv?: Record<string, string>;
  /** The files that same `setup` returned. */
  files?: readonly ServiceFile[];
  /**
   * The roles resolved across what this host deploys. What this service needs
   * from them is the proxy that routes to it — which writes the route file, in
   * its own dialect and its own watched directory — and the gate a route with
   * `auth: "edge"` is sent through.
   */
  catalog: Catalog;
  /** Extra ssh arguments, for reaching a host that is not in the real ssh_config. */
  sshArgs?: readonly string[];
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export default class Service extends pulumi.ComponentResource {
  /** `/var/lib/<name>`, when the service has state worth restoring. */
  public readonly backupPath: string | undefined;
  public readonly unit: SystemdUnit;

  constructor(args: ServiceArgs, opts?: pulumi.ComponentResourceOptions) {
    const { host, spec, ramMb, image, sealedEnv, extraEnv, files = [], catalog, sshArgs } = args;
    super("keel:index:Service", spec.name, {}, opts);
    const parent = { parent: this };

    // A preview has no digest for a rolling tag — the resource that resolves one
    // has not run — so what it shows is the tag the digest will come from. On an
    // apply the resolved digest is what reaches the file.
    const quadlet = pulumi
      .output(image)
      .apply((pinned) =>
        renderQuadlet({ ...spec, image: pinned ?? spec.image }, extraEnv, catalog),
      );
    const quadletFile = new RemoteFile(
      `${spec.name}-quadlet`,
      { host, sshArgs, path: quadletPath(spec), content: quadlet, mode: "644" },
      parent,
    );

    // The caps, from the profile this board qualifies for. A quadlet states the
    // slice and no numbers, and the image stages nothing for a service it does
    // not run — so this drop-in is the only thing that sets them, and it lands
    // in /etc, which outranks both the image and the boot-time generator.
    const memory = serviceDropIn(spec.name, selectProfile(ramMb));
    const memoryFile = new RemoteFile(
      `${spec.name}-memory`,
      { host, sshArgs, path: memoryDropInPath(spec.name), content: memory, mode: "644" },
      parent,
    );

    const secrets = secretsPath(spec);
    const secretFile =
      secrets && sealedEnv
        ? new SecretFile(
            `${spec.name}-secret`,
            { host, sshArgs, path: `${secrets}.age`, ...sealedEnv },
            parent,
          )
        : undefined;

    // The route is the proxy's file: which dialect it is written in and where it
    // lands are the proxy role's to say, and the gate a gated route asks is
    // resolved by role rather than named here. The zone and the allowlist
    // exceptions belong to an installation, so they are handed to the renderer
    // rather than read by it. With no proxy deployed nothing watches a directory,
    // so nothing is written into one.
    let routeFile: RemoteFile | undefined;
    if (catalog.proxy !== undefined) {
      const route = catalog.proxy.role.route(spec, {
        domain: INSTALLATION.network.domain,
        publicHosts: INSTALLATION.publicHosts,
        gate: catalog.gate,
      });
      if (route !== null) {
        routeFile = new RemoteFile(
          `${spec.name}-route`,
          {
            host,
            sshArgs,
            path: catalog.proxy.role.routePath(spec),
            content: route,
            mode: "644",
          },
          parent,
        );
      }
    }

    // No packet-filter drop-in here. The ports a service asks for reach the
    // filter through one file for the whole host, written by the program beside
    // the reload that makes the kernel agree: `nft -f` merges, so only a reload
    // closes a port — and Pulumi deletes after it updates, so a per-service file
    // would still be on disk, re-admitting the port, when that reload ran.
    const extraFiles = files.map(
      (entry) =>
        new RemoteFile(
          `${spec.name}-${entry.name}`,
          { host, sshArgs, path: entry.path, content: entry.content, mode: entry.mode ?? "644" },
          parent,
        ),
    );

    // The unit restarts when what it runs or how it is capped changes, and not
    // otherwise — the whole job the stamp files used to do. Traefik hot-reloads
    // its own dynamic config, so a route change deliberately restarts nothing,
    // and a `files` entry says for itself which kind it is. The trigger folds in
    // the secret's plaintext hash, so rotating a credential restarts the service
    // that reads it: the quadlet body has not changed, and without this the new
    // value would sit on disk unread until something else happened to restart
    // the unit.
    const restarting = files
      .filter((entry) => entry.restarts !== false)
      .map((entry) => entry.content);
    const deps = [
      quadletFile,
      memoryFile,
      ...extraFiles,
      ...(routeFile ? [routeFile] : []),
      ...(secretFile ? [secretFile] : []),
    ];
    this.unit = new SystemdUnit(
      spec.name,
      {
        host,
        sshArgs,
        unit: `${spec.name}.service`,
        quadlet: true,
        trigger: pulumi.all([quadlet, sealedEnv?.plaintextHash ?? ""]).apply(([body, secretHash]) =>
          // Each part hashed before it is joined: fixed-length pieces cannot run
          // together, so a boundary shifting between two of them is a change.
          sha256([body, memory, ...restarting, secretHash].map(sha256).join("")),
        ),
      },
      { ...parent, dependsOn: deps },
    );

    // The same function the backup's own path list is derived from, so the two
    // cannot disagree about where a service keeps its state.
    this.backupPath = backupPath(spec) ?? undefined;

    // Still to land: a DNS record for a service with a subdomain, and an OIDC
    // client registered with the identity role for one with `auth: "oidc"`, whose
    // generated secret flows into the encrypted env blob inside the same run —
    // no second deploy.

    this.registerOutputs({ backupPath: this.backupPath });
  }
}
