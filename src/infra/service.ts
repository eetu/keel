/**
 * One service, declared once.
 *
 * A `Service` fans a single `ServiceSpec` out into every resource that service
 * needs: the quadlet, its memory caps, the systemd unit that runs it, the route
 * file the proxy serves it on, and any credential another service issues it —
 * generated and sealed where it is used, never stored anywhere in between. The
 * ports the packet filter admits to it are published rather than written,
 * because that file belongs to the host rather than to any one service. The
 * seam for the one resource that still needs its own provider — the OIDC client
 * the identity provider registers — is marked below and lands with it.
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
import * as random from "@pulumi/random";

import { INSTALLATION } from "../config/installation";
import { selectProfile } from "../config/profiles";
import {
  backupPath,
  type Catalog,
  deployedAccountEmail,
  isSecretsPath,
  metricsSecretsPath,
  SECRETS_DIR,
  secretsPath,
  type ServiceSpec,
} from "../config/spec";
import { type ServiceFile, type ServiceSecretFile } from "../config/types";
import { memoryDropInPath, serviceDropIn } from "../render/memory";
import { quadletPath, renderQuadlet } from "../render/quadlet";
import { MetricsAccount } from "./providers/metricsAccount";
import { RemoteFile } from "./providers/remoteFile";
import { SealedText } from "./providers/sealedText";
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
   * The ones whose body carries key material this deploy draws. Each becomes a
   * generated value per name it asks for, one sealed blob, and one file — and
   * the plaintext exists only inside the apply that builds it and the resource
   * input that carries it, encrypted, into state.
   */
  secretFiles?: readonly ServiceSecretFile[];
  /**
   * The roles resolved across what this host deploys. What this service needs
   * from them is the proxy that routes to it — which writes the route file, in
   * its own dialect and its own watched directory — and the gate a route with
   * `auth: "edge"` is sent through.
   */
  catalog: Catalog;
  /**
   * The resources of the services this one is started after — the same edges
   * `dependencyNames` derives, as the units themselves. A credential generated
   * on another service is created against a hub that is answering, and that is
   * what makes it so.
   */
  needs?: readonly pulumi.Resource[];
  /**
   * Public half of the age identity on the board, for the credentials this
   * service's own resources generate. A vault-read secret is sealed before it
   * reaches here; a generated one is sealed inside the resource that makes it,
   * which is why the recipient is needed at this level too.
   */
  ageRecipient?: string;
  /** Extra ssh arguments, for reaching a host that is not in the real ssh_config. */
  sshArgs?: readonly string[];
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export default class Service extends pulumi.ComponentResource {
  /** `/var/lib/<name>`, when the service has state worth restoring. */
  public readonly backupPath: string | undefined;
  public readonly unit: SystemdUnit;

  constructor(args: ServiceArgs, opts?: pulumi.ComponentResourceOptions) {
    const {
      host,
      spec,
      ramMb,
      image,
      sealedEnv,
      extraEnv,
      files = [],
      secretFiles = [],
      catalog,
      needs = [],
      ageRecipient,
      sshArgs,
    } = args;
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

    // A file whose body is key material rather than configuration: one value
    // drawn per name the entry asks for, the body composed from them, sealed for
    // this board and written as a blob `keel-secrets.service` opens. The
    // plaintext exists in the apply that composes it and as an input the engine
    // encrypts with the stack's own key — never as a value a provider captures,
    // which is what would put it in state in the clear.
    const generated = secretFiles.map((entry) => {
      if (!isSecretsPath(entry.path)) {
        throw new Error(
          `${spec.name}'s ${entry.name} file lands at ${entry.path}, which nothing decrypts — ` +
            `a generated file belongs directly under ${SECRETS_DIR}`,
        );
      }
      if (ageRecipient === undefined) {
        throw new Error(
          `${spec.name} carries a generated file but ${host} has no ageRecipient — ` +
            "generate an identity on the host and record its public half",
        );
      }
      const values = Object.fromEntries(
        Object.entries(entry.generate).map(([name, shape]) => {
          // `protect` is the entry saying what a replacement would cost: a value
          // that is the only key to data already written is one Pulumi must
          // refuse to redraw, because a fresh one leaves that data unreadable.
          const bytes = new random.RandomBytes(
            `${spec.name}-${name}`,
            { length: shape.bytes },
            { ...parent, protect: shape.protect === true },
          );
          return [name, shape.encoding === "hex" ? bytes.hex : bytes.base64];
        }),
      );
      const sealed = new SealedText(
        `${spec.name}-${entry.name}`,
        {
          // Stated rather than inherited: every drawn value is already a secret
          // output, so the body is one — and a file that draws nothing is still
          // a file whose body has no business being read out of a plan.
          plaintext: pulumi.secret(pulumi.all(values).apply((drawn) => entry.content(drawn))),
          ageRecipient,
        },
        parent,
      );
      return {
        plaintextHash: sealed.plaintextHash,
        file: new SecretFile(
          `${spec.name}-${entry.name}-file`,
          {
            host,
            sshArgs,
            path: `${entry.path}.age`,
            ciphertext: sealed.ciphertext,
            plaintextHash: sealed.plaintextHash,
          },
          parent,
        ),
      };
    });

    // An account on another service, generated rather than read: the entry says
    // it needs one and which two variables it reads the login out of, the hub is
    // whichever entry claims the metrics role, and the password is created and
    // sealed inside the resource — so it is in no vault and in no state file.
    // The hub is called from the board over ssh, so this needs the same host and
    // ssh arguments every other resource here takes. Ordered behind the same
    // services the container is, because the account is made by calling the hub
    // and a hub that is not up has nothing to make.
    //
    // A consumer with no hub deployed is one of the gaps refused before any of
    // this is built, so there is no branch here for a declaration with nothing
    // to satisfy it.
    const metricsPath = metricsSecretsPath(spec);
    const account =
      spec.metricsAccount === undefined || catalog.metrics === undefined || !ageRecipient
        ? undefined
        : new MetricsAccount(
            `${spec.name}-metrics-account`,
            {
              host,
              sshArgs,
              vault: INSTALLATION.vault,
              item: catalog.metrics.spec.vaultItem ?? catalog.metrics.spec.name,
              // Loopback, because the hub is talked to from the board rather
              // than from here — the same address this service's own
              // configuration dials it on, and the only one that needs no
              // opinion about whether a laptop can route to the LAN.
              hubUrl: `http://127.0.0.1:${catalog.metrics.spec.port}`,
              email: deployedAccountEmail(spec, INSTALLATION.network.domain),
              role: spec.metricsAccount.role,
              api: catalog.metrics.role.api,
              superuser: catalog.metrics.role.superuser,
              envNames: spec.metricsAccount.env,
              ageRecipient,
            },
            { ...parent, dependsOn: [...needs] },
          );
    const metricsFile =
      account === undefined || metricsPath === null
        ? undefined
        : new SecretFile(
            `${spec.name}-metrics-secret`,
            {
              host,
              sshArgs,
              path: `${metricsPath}.age`,
              ciphertext: account.ciphertext,
              plaintextHash: account.plaintextHash,
            },
            parent,
          );

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
      ...(metricsFile ? [metricsFile] : []),
      ...generated.map((entry) => entry.file),
    ];
    // Empty for a service with no generated file, which is every service but
    // one — and an empty string is what keeps that service's trigger the value
    // it already had.
    const generatedHash: pulumi.Input<string> =
      generated.length === 0
        ? ""
        : pulumi
            .all(generated.map((entry) => entry.plaintextHash))
            .apply((hashes) => hashes.join(""));
    this.unit = new SystemdUnit(
      spec.name,
      {
        host,
        sshArgs,
        unit: `${spec.name}.service`,
        quadlet: true,
        trigger: pulumi
          .all([
            quadlet,
            sealedEnv?.plaintextHash ?? "",
            account?.plaintextHash ?? "",
            generatedHash,
          ])
          .apply(([body, secretHash, accountHash, fileHash]) =>
            // Each part hashed before it is joined: fixed-length pieces cannot
            // run together, so a boundary shifting between two of them is a
            // change. Every credential joins the secret's own part rather than
            // becoming another one — a new part would change every trigger in
            // the fleet, restarting the resolver, the proxy and the identity
            // provider for a value none of them has.
            sha256(
              [body, memory, ...restarting, secretHash + accountHash + fileHash]
                .map(sha256)
                .join(""),
            ),
          ),
      },
      { ...parent, dependsOn: deps },
    );

    // The same function the backup's own path list is derived from, so the two
    // cannot disagree about where a service keeps its state.
    this.backupPath = backupPath(spec) ?? undefined;

    // Still to land: an OIDC client registered with the identity role for a
    // service with `auth: "oidc"`, whose generated secret flows into an
    // encrypted env blob inside the same run — the shape the account above
    // already has, with the identity provider in the hub's place.

    this.registerOutputs({ backupPath: this.backupPath });
  }
}
