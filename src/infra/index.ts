/**
 * The Pulumi program. One stack per host; the stack name is the host's
 * ssh_config alias, which is also how the providers reach it.
 *
 * Pulumi owns what changes often and has something to read back: the services,
 * their routes, their caps, the ports the packet filter admits to them, the
 * public DNS records, the mesh's own account state, and (as they land) Kanidm
 * clients and each host's booted image digest. The image owns the machine.
 *
 * **Nothing here shells out.** Pulumi previews by evaluating this file, so a
 * registry lookup or a vault read at module scope would fire on every
 * `pulumi preview`. Both live inside resources instead — `ImageDigest` and
 * `SealedEnv` — which is why picking up a moved tag or a rotated credential is
 * `pulumi up --refresh` and neither costs a bare preview anything. The zone
 * lookup below is the exception and is one on purpose: it is the official
 * Cloudflare provider's own invoke, so it runs whenever this file is evaluated,
 * out of a token `scripts/pulumi.ts` puts in the environment beforehand.
 */

import { createHash } from "node:crypto";

import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

import { BACKUP_SECRET_ENV, BACKUP_VAULT_ITEM, RESTIC_IMAGE } from "../config/backup";
import { INSTALLATION } from "../config/installation";
import { REMOTES, SERVICES } from "../config/services";
import {
  alertUrl,
  catalogOf,
  dependencyNames,
  deployedAccountEmail,
  deploymentGaps,
  orderServices,
  publicRecords,
  resolveSecretRefs,
  runSetup,
  secretFields,
  secretsPath,
  serviceOrigin,
} from "../config/spec";
import { ALERT_CONFIG_PATH, renderAlertConfig } from "../render/alert";
import { BACKUP_SECRETS_PATH, backupSet, renderBackupConfig } from "../render/backup";
import { HOSTS_CONFIG_PATH, KEEL_HOSTS_SERVICE, renderHostsConfig } from "../render/hosts";
import { MESH_INTERFACE } from "../render/mesh";
import { isIpAddress, mountedShares } from "../render/mount";
import { NFT_FORWARD_PATH, renderNftForward } from "../render/nftForward";
import { NFT_SERVICES_PATH, publicProxyIngress, renderNftServices } from "../render/nftPorts";
import { NETWORK_NAMES, networkQuadlet } from "../render/quadlet";
import CertSync from "./certSync";
import KeelBackup from "./keelBackup";
import CifsMount from "./mount";
import declareMesh from "./netbird";
import { ImageDigest } from "./providers/imageDigest";
import { BootstrapAccount, BootstrapConnector } from "./providers/netbirdAccount";
import { RemoteFile } from "./providers/remoteFile";
import { SealedEnv } from "./providers/sealedEnv";
import { SystemdUnit } from "./providers/systemdUnit";
import Service from "./service";

const config = new pulumi.Config();

const hostName = pulumi.getStack();
const host = INSTALLATION.hosts[hostName];
if (!host) {
  throw new Error(
    `stack '${hostName}' is not a known host — see INSTALLATION.hosts in src/config/installation.ts`,
  );
}

/**
 * Where to actually connect. Defaults to the stack name, which is the ssh_config
 * alias of the real machine — so a stack called `raspi` reaches raspi unless told
 * otherwise, and a test has to say so explicitly rather than by omission.
 */
const sshTarget = config.get("sshTarget") ?? hostName;

/** An alternate ssh_config, for reaching a guest that is not in the real one. */
const sshConfigPath = config.get("sshConfig");
const sshArgs = sshConfigPath === undefined ? undefined : ["-F", sshConfigPath];

if (sshTarget !== hostName) {
  pulumi.log.warn(`deploying ${hostName}'s configuration to '${sshTarget}', not to ${hostName}`);
}

/**
 * Whose age identity secrets are sealed to. Normally the host's, recorded in
 * `installation.ts` when the identity is generated on it; overridable per stack so a
 * throwaway target (a QEMU guest, a rebuilt host) can carry its own without it
 * being written into shared config.
 */
const ageRecipient = config.get("ageRecipient") ?? host.ageRecipient;

/**
 * The vault every secret field is read out of. It comes from the installation
 * object rather than from the environment, because which vault holds this
 * fleet's items is a fact about the fleet — and a default here would be one
 * house's vault name that every other deploy read without being told.
 */
const vault = INSTALLATION.vault;

/**
 * What this host runs: the whole catalog, or exactly the entries its `services`
 * list names.
 *
 * That list is the whole selector, and it is checked before anything is planned:
 * a name no entry is called is a typo, and a typo that filtered to nothing would
 * be a service that silently never arrives — the one failure a selector must not
 * have. There is no per-stack subset beyond it to bring services up in stages,
 * because the ordering a staged deploy would stand in for is in the graph — the
 * resolver before the proxy, the proxy before the certificate its reader waits
 * for, the issuer before the gate that asks it.
 */
const listed = host.services;
const unknown = (listed ?? []).filter((name) => !SERVICES.some((spec) => spec.name === name));
if (unknown.length > 0) {
  throw new Error(
    `${hostName} lists ${unknown.map((name) => `'${name}'`).join(", ")}, which no catalog entry ` +
      `is called — known: ${SERVICES.map((spec) => spec.name).join(", ")}`,
  );
}
const mine =
  listed === undefined ? SERVICES : SERVICES.filter((spec) => listed.includes(spec.name));

/**
 * Which deployed entry is the proxy, the identity provider and the gate. Resolved
 * over what this host actually deploys rather than over the whole catalog, so a
 * capability an entry needs is one that will be running beside it — and two
 * entries claiming one role stops here, because there is no answer to which of
 * them a route or a client should be pointed at.
 *
 * Remotes are not filtered by the host's `services` list — nothing about one
 * runs on any board, so there is no host to select it off of. What decides
 * whether its route is ever written is the proxy gap below.
 */
const catalog = catalogOf(mine, REMOTES);

/**
 * Everything the deployed set names and would not find, raised while the plan is
 * still on someone's screen. A route referencing a middleware the proxy has no
 * definition for is a router it refuses to build: the vhost fails closed, with
 * the reason in a log nobody is reading. That is the failure this exists for.
 */
const gaps = deploymentGaps(catalog);
for (const warning of gaps.warnings) pulumi.log.warn(warning);
if (gaps.errors.length > 0) {
  throw new Error(`${sshTarget}: ${gaps.errors.join("; ")}`);
}

/**
 * The deployed set in an order that starts each service after what it needs
 * running, and the refusal of a set that has no such order. The whole catalog is
 * passed as well, so a dependency this host's `services` list leaves out is
 * reported as the selection question it is rather than as a name nobody has heard
 * of.
 */
const ordered = orderServices(catalog, SERVICES);

/**
 * `SealedEnv`'s two halves, from a resolved variable -> item/field map: the field
 * each variable reads, and — only for the variables whose field is on some other
 * item — which item that is. `fieldItems` is left off entirely when there are
 * none, because an absent key and an empty map have to look the same to a diff.
 */
function sealedFields(
  item: string,
  sources: Record<string, { item: string; field: string }>,
): { fields: Record<string, string>; fieldItems?: Record<string, string> } {
  const fields = Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [name, source.field]),
  );
  const foreign = Object.fromEntries(
    Object.entries(sources)
      .filter(([, source]) => source.item !== item)
      .map(([name, source]) => [name, source.item]),
  );
  return { fields, ...(Object.keys(foreign).length > 0 ? { fieldItems: foreign } : {}) };
}

/**
 * The NAS shares this host holds, one component each — created because something
 * being deployed binds a path under one, so a network's other shares cost this
 * board no credentialed access to them. The service's ordering against the mount
 * is quadlet's, derived from the `Volume=` source, so the one thing checked here
 * is that the source is spelled the way that derivation can see it.
 */
const shares = mountedShares(mine, INSTALLATION.shares);
if (shares.length > 0 && ageRecipient === undefined) {
  throw new Error(
    `${sshTarget} mounts ${shares.map((mount) => mount.share.mountpoint).join(", ")} but has ` +
      "no ageRecipient — generate an identity on the host and record its public half",
  );
}

/**
 * Every name a share or the backup target is given rather than addressed —
 * `keel-hosts.service`'s own input, written whether or not it names anything
 * for the reason `nft-services` below is: an absent file and a present but
 * empty one converge differently, and only the second is safe for a run with
 * nothing to resolve to overwrite blindly.
 */
const hostNames = [
  ...shares.map((mount) => mount.share.host),
  ...(host.backup === true ? [INSTALLATION.backup.host] : []),
].filter((name) => !isIpAddress(name));
const hostsConfig = renderHostsConfig(hostNames);
const hostsFile = new RemoteFile("keel-hosts-config", {
  host: sshTarget,
  sshArgs,
  path: HOSTS_CONFIG_PATH,
  content: hostsConfig,
  mode: "644",
});
// `reload`, for the same reason `nftables` below is: the unit is the image's, it
// ran at boot and stays active, so a `start` on it does nothing — and a name
// written after boot has to be resolved before the mount unit written beside it
// asks for it, not at the timer's next tick. Its ExecReload= is the resolver
// itself, and a destroy leaves the unit and the timer alone.
const hostsUnit = new SystemdUnit(
  "keel-hosts",
  {
    host: sshTarget,
    sshArgs,
    unit: KEEL_HOSTS_SERVICE,
    quadlet: false,
    action: "reload",
    trigger: createHash("sha256").update(hostsConfig).digest("hex"),
  },
  { dependsOn: [hostsFile] },
);

/**
 * Where the image's failure poller posts: the sink the catalog declares, or a
 * file saying there is none. Written unconditionally for the reason the names
 * file above is, and read by `keel-alert.service` at its next tick — nothing to
 * restart, because the poller reads it fresh every time it runs.
 */
new RemoteFile("keel-alert-config", {
  host: sshTarget,
  sshArgs,
  path: ALERT_CONFIG_PATH,
  content: renderAlertConfig(catalog.alerts === undefined ? undefined : alertUrl(catalog.alerts)),
  mode: "644",
});

/**
 * A share's mount depends on this host's name reaching `/etc/hosts` first:
 * `mount.cifs` resolves through `getaddrinfo`, which reads that file before it
 * asks anything else, so a name absent from it is a mount that fails on its
 * first attempt.
 */
const mounts = new Map(
  shares.map((mount) => [
    mount.unit,
    new CifsMount(
      { host: sshTarget, mount, vault, ageRecipient: ageRecipient!, sshArgs },
      { dependsOn: [hostsUnit] },
    ),
  ]),
);

/**
 * The image ships the same two files under `/usr/share/containers/systemd`;
 * these shadow them (quadlet reads `/etc` first), so a network fix reaches a
 * running host as a `pulumi up` rather than an image rebuild and a reboot.
 * Written only where something will join one.
 */
const networks = mine.some((spec) => (spec.egress ?? "internal") !== "host")
  ? (["internal", "open"] as const).map(
      (kind) =>
        new RemoteFile(`network-${NETWORK_NAMES[kind]}`, {
          host: sshTarget,
          sshArgs,
          path: `/etc/containers/systemd/${NETWORK_NAMES[kind]}.network`,
          content: networkQuadlet(NETWORK_NAMES[kind], kind),
          mode: "644",
        }),
    )
  : [];

/**
 * What this board forwards for, as a packet-filter drop-in.
 *
 * Two rules and two questions, both answered from the deployed set. The open
 * bridge's accept is carried only where something is actually on that bridge;
 * the image carries the same rule, so this is what closes the gap on a board
 * booted from one that predates it — a `pulumi up` rather than a rebuild and a
 * reboot of the host that answers LAN DNS. The mesh interface's accept is
 * carried only where this board enrols as the overlay's routing peer, and it is
 * in no image at all: the forward chain is policy drop, so without this line the
 * agent connects, the routes exist, the dashboard is green and every packet a
 * connected device aims at the LAN is dropped by this host.
 *
 * Written whether or not it has a rule in it, for the reason the port file below
 * is one file: withdrawing an accept has to be an *update*, because a deletion
 * runs after the reload and the reload would re-read the copy still on disk.
 */
const routesTheMesh = mine.some(
  (spec) => runSetup(spec, INSTALLATION, catalog)?.mesh?.agent !== undefined,
);
const forwardRules = renderNftForward(
  mine.some((spec) => (spec.egress ?? "internal") === "open"),
  routesTheMesh ? MESH_INTERFACE : undefined,
);
const forwardFile = new RemoteFile("nft-forward-open", {
  host: sshTarget,
  sshArgs,
  path: NFT_FORWARD_PATH,
  content: forwardRules,
  mode: "644",
});

/**
 * Every service, built in dependency order.
 *
 * The order is what makes the map safe to read: by the time an entry is reached,
 * everything it depends on is already in it, so the `dependsOn` handed to Pulumi
 * is the real resource — the unit whose start command has returned — rather than
 * a name the engine is left to schedule around.
 */
const services = new Map<string, Service>();
for (const spec of ordered) {
  // A rolling tag becomes a resource that resolves it; a pinned one passes
  // straight through, so a digest nobody is going to move costs no lookup and no
  // resource. Either way what reaches the quadlet is a digest: the plan shows a
  // digest changing, the restart follows from that change, and the previous
  // digest stays in state to roll back to.
  const image = spec.image.includes("@sha256:")
    ? spec.image
    : new ImageDigest(`${spec.name}-image`, { ref: spec.image }).digestRef;

  // What this service has to be started after, as the resources themselves. Both
  // derived edges resolve to an entry already built, because the order they were
  // walked in is the order they imply.
  const needs = dependencyNames(spec, catalog).map((name) => services.get(name)!);

  // The installation-shaped half of this service's configuration, composed by
  // the entry itself from the house and the roles beside it. Nothing here decides
  // what a particular service needs. Pure, so reading it costs nothing and it is
  // read before the secrets, one of which it can ask for.
  const setup = runSetup(spec, INSTALLATION, catalog);

  // Read, seal, write — all three inside the resource. What reaches the state
  // file is ciphertext and a hash; the identity that opens it lives only on the
  // host, and the plaintext exists only inside the provider's own call.
  const needsSecrets = secretsPath(spec) !== null && spec.secretEnv !== undefined;
  // A generated credential is sealed for the board in the resource that makes
  // it, so an entry with an account on another service — or a file this deploy
  // draws the key material for — needs the identity for exactly the reason a
  // vault-read secret does.
  const generates = spec.metricsAccount !== undefined || (setup?.secretFiles?.length ?? 0) > 0;
  if ((needsSecrets || generates) && ageRecipient === undefined) {
    throw new Error(
      `${spec.name} needs secrets but ${sshTarget} has no ageRecipient — ` +
        "generate an identity on the host and record its public half",
    );
  }
  // A field is read from the service's own item unless the entry says otherwise.
  const item = spec.vaultItem ?? spec.name;
  // Ordered behind the same services the container is, because a credential can
  // be one of *them*: the gate's client secret exists only once the identity
  // provider it belongs to is running and the client has been registered against
  // it. With no edge here that read is a root of the graph — it runs in the first
  // seconds, fails by name, and takes down a run that had not yet started the
  // service which would have made the field answerable. This is what makes a
  // fresh installation's first `up` stop *at* the gate rather than before
  // anything.
  const sealed =
    needsSecrets && ageRecipient
      ? new SealedEnv(
          `${spec.name}-env`,
          {
            vault,
            item,
            ...sealedFields(item, secretFields(spec)),
            ageRecipient,
          },
          { dependsOn: needs },
        )
      : undefined;

  /**
   * The units that fill a certificate directory an entry declared, created with
   * that service and removed with it — the declaration decides, not a name
   * matched here, and the pair is named after whoever declared it.
   *
   * Ordered after the proxy that fills the store, because the one-shot waits for
   * a certificate to appear in it and the proxy is what puts one there. The
   * proxy is deployed because a reader with no store to read from is one of the
   * gaps refused above.
   */
  const certSync =
    spec.certificates === undefined
      ? undefined
      : new CertSync(
          { host: sshTarget, sshArgs, proxy: catalog.proxy!.role, consumer: spec },
          { dependsOn: [services.get(catalog.proxy!.spec.name)!] },
        );

  const service = new Service(
    {
      host: sshTarget,
      spec,
      ramMb: host.ramMb,
      image,
      sealedEnv: sealed && { ciphertext: sealed.ciphertext, plaintextHash: sealed.plaintextHash },
      extraEnv: setup?.env,
      files: setup?.files,
      secretFiles: setup?.secretFiles,
      catalog,
      // The same edges, as the resources themselves: a credential this service's
      // own resources generate is created by calling a service that is up.
      needs,
      ageRecipient,
      sshArgs,
    },
    // The network files have to be in place before anything joins one, and the
    // cert units before the first start of whatever wants them — or that start
    // has no certificate. A share has to be mounted before the container that
    // binds it, or podman creates the source directory and the service serves
    // whatever is in it, which is nothing.
    {
      dependsOn: [
        ...networks,
        ...needs,
        ...(certSync ? [certSync] : []),
        ...shares
          .filter((mount) => mount.consumers.includes(spec.name))
          .map((mount) => mounts.get(mount.unit)!),
      ],
    },
  );
  services.set(spec.name, service);
}

/**
 * The first account on a service that boots unclaimed, and the identity provider
 * its own broker federates to.
 *
 * Here rather than inside `Service` for the same reason a public DNS record is:
 * what it produces is a credential the *deploy* holds — the token the declarative
 * providers for that service's own state will authenticate with — and not a file
 * on the board. Nothing in the container's own resources reads it.
 *
 * Ordered after the service's unit, because an account is claimed by calling
 * something that answers, and the connector after the account because the call
 * that registers it carries the token the account resource returned. The issuer
 * comes from whichever entry claims the identity role, asked for the client the
 * connector is registered as — so neither end spells a URL and the two cannot
 * drift into naming different clients. A `connector` with no identity role
 * deployed is one of the gaps refused before any of this is built.
 */
for (const spec of mine) {
  const bootstrap = spec.bootstrapAccount;
  // The declarative half of the same service: state behind its own API, which
  // every call authenticates for with the token the account below returns. So an
  // entry that declares one without the other has nothing to authenticate as,
  // and that is a plan refused here rather than a provider configured with an
  // empty credential and a run that fails resource by resource.
  const mesh = runSetup(spec, INSTALLATION, catalog)?.mesh;
  if (bootstrap === undefined) {
    if (mesh !== undefined) {
      throw new Error(
        `${spec.name} declares the state a deploy holds on its own API and no account for the ` +
          "deploy to claim — there is no token to authenticate those calls with",
      );
    }
    continue;
  }
  const account = new BootstrapAccount(
    `${spec.name}-account`,
    {
      host: sshTarget,
      sshArgs,
      // Loopback, because the service is talked to from the board rather than
      // from here — the same address its own configuration is written with.
      apiUrl: `http://127.0.0.1:${spec.port}`,
      api: bootstrap.api,
      // The account's address is derived, the same as the hub account's: it
      // identifies a machine account nobody reads mail at, and it is also the
      // local login a person signs in with when the token has to be replaced.
      email: deployedAccountEmail(spec, INSTALLATION.network.domain),
      name: bootstrap.name,
      tokenDays: bootstrap.tokenDays,
      vault,
      token: bootstrap.token,
    },
    { dependsOn: [services.get(spec.name)!] },
  );
  if (bootstrap.connector !== undefined) {
    new BootstrapConnector(
      `${spec.name}-connector`,
      {
        host: sshTarget,
        sshArgs,
        apiUrl: `http://127.0.0.1:${spec.port}`,
        api: bootstrap.api,
        accessToken: account.accessToken,
        name: bootstrap.connector.name,
        clientId: bootstrap.connector.clientId,
        issuer: catalog.identity!.role.issuer(
          serviceOrigin(catalog.identity!.spec, INSTALLATION.network.domain),
          bootstrap.connector.clientId,
        ),
        vault,
        secret: bootstrap.connector.secret,
      },
      { dependsOn: [account] },
    );
  }
  if (mesh !== undefined) {
    // The public vhost, not the loopback the two resources above use: the
    // bridged provider is a plugin process running where this program runs, so
    // it dials the coordinator the way anything off the board does. That is the
    // one thing in this stack that needs a route to that name from the deploy
    // machine — see `netbird.ts` for the trade.
    declareMesh({
      name: spec.name,
      origin: serviceOrigin(spec, INSTALLATION.network.domain),
      token: account.accessToken,
      state: mesh,
      // The one half of that file which is not an API call: the routing peer is
      // this board's own agent, enrolled over ssh with a key sealed for its age
      // identity, the way every other device resource reaches a machine.
      board: { host: sshTarget, sshArgs, ageRecipient },
    });
  }
}

/**
 * One route file per remote — a vhost to a machine the board does not run, so
 * there is no unit, no cap and nothing else to build for it. `dependsOn` names
 * nothing: a route file needs nothing running to be written, the same as a
 * service's own.
 *
 * A route without a proxy to read it is a file nobody watches, so a deployed
 * remote with no deployed proxy is refused here rather than written silently —
 * `deploymentGaps` cannot say this on its own, because it has no resource to
 * point at the file that would go unread.
 */
if (catalog.remotes.length > 0 && catalog.proxy === undefined) {
  throw new Error(
    `${sshTarget}: ${catalog.remotes.map((remote) => remote.name).join(", ")} route to a ` +
      "machine off the board, and no deployed entry claims the proxy role — their route files " +
      "would sit in a directory nothing watches",
  );
}
for (const remote of catalog.remotes) {
  new RemoteFile(`${remote.name}-route`, {
    host: sshTarget,
    sshArgs,
    path: catalog.proxy!.role.routePath(remote),
    content: catalog.proxy!.role.route(remote, {
      domain: INSTALLATION.network.domain,
      publicHosts: INSTALLATION.publicHosts,
      gate: catalog.gate,
    })!,
    mode: "644",
  });
}

/**
 * One Cloudflare A record per `publicDns: true` vhost — service or remote —
 * pointing at the same address the LAN's own record does: the board the proxy
 * runs on. Never proxied through Cloudflare: its HTTP proxy would front a LAN
 * address Cloudflare cannot reach anyway, and TLS terminates on the board, not
 * at Cloudflare's edge. ttl 120 so a moved address propagates in minutes.
 *
 * The zone is looked up once for the host rather than per record: the lookup is
 * a provider invoke, so it is a Cloudflare round-trip every time this file is
 * evaluated, and twenty of them would be twenty. Nothing looks it up at all on
 * a host with no public name, which is also what keeps such a stack's preview
 * free of the API entirely.
 *
 * No `dependsOn`: a DNS record needs nothing running to be correct, the same
 * as a route file.
 */
const publicNames = publicRecords(catalog, INSTALLATION.network);
if (publicNames.length > 0) {
  const { zoneId } = cloudflare.getZoneOutput({
    filter: { name: INSTALLATION.network.domain },
  });
  for (const record of publicNames) {
    new cloudflare.DnsRecord(`${record.name}-dns`, {
      zoneId,
      name: record.fqdn,
      type: "A",
      content: record.content,
      ttl: 120,
      proxied: false,
      comment: "keel",
    });
  }
}

/**
 * Every port the deployed set asks for, in one file for the host.
 *
 * One file rather than one per service, because `nft -f` merges and Pulumi runs
 * deletions after updates. A retired service's own drop-in would still be on
 * disk when the reload below re-reads the glob — so the reload run to close that
 * port would re-admit it, and it would stay open until the next reload or the
 * next boot. Retiring a service is an update of this file, in the same run that
 * reloads from it.
 *
 * Written even when the set asks for no port at all, which is the last version of
 * the same bug: a body of "nothing" that became an absent file would be a
 * deletion, and the reload it was meant to precede would re-read the file still
 * on disk and re-admit every port in it.
 */
// The proxy answers the internet only where a vhost has opted out of the
// allowlist; `publicProxyIngress` derives that rather than the committed entry
// declaring it, so a clone with no public name keeps :443 on the LAN.
const publicProxy = publicProxyIngress(catalog, INSTALLATION.publicHosts);
const portRules = renderNftServices(
  publicProxy === null
    ? mine
    : mine.map((spec) => (spec.name === publicProxy.name ? publicProxy : spec)),
);
const portsFile = new RemoteFile("nft-services", {
  host: sshTarget,
  sshArgs,
  path: NFT_SERVICES_PATH,
  content: portRules,
  mode: "644",
});

// One reload for the whole packet filter, because only a reload can close a
// port: `nft -f` merges a re-declared set, so re-applying a file that no longer
// names a port leaves it in the kernel. `nftables.service`'s ExecReload flushes
// the ruleset and re-reads it from `/etc/sysconfig/nftables.conf`, which re-runs
// the `/etc/keel/nft.d/*.nft` glob — the drop-ins that remain, and only those.
//
// Triggered by the bodies themselves rather than by a list of them, so what
// reloads the filter is a change in what the filter would read.
//
// The unit belongs to the image, so this resource reloads it and never stops it:
// `action: "reload"` also means a destroy leaves the filter running.
new SystemdUnit(
  "nftables",
  {
    host: sshTarget,
    sshArgs,
    unit: "nftables.service",
    quadlet: false,
    action: "reload",
    trigger: createHash("sha256").update([portRules, forwardRules].join("\n")).digest("hex"),
  },
  { dependsOn: [portsFile, forwardFile] },
);

/**
 * Backups, for a host that says it has somewhere to put them. The snapshot set is
 * the whole catalog's state directories rather than the subset this host deploys:
 * a path that does not exist on the board is skipped at run time, and a backup
 * that covered less than the host holds because its list was narrowed for a
 * while would be a backup nobody would notice was thin.
 */
if (host.backup === true) {
  if (ageRecipient === undefined) {
    throw new Error(
      `${sshTarget} states backup: true but has no ageRecipient — ` +
        "generate an identity on the host and record its public half",
    );
  }
  const sealed = new SealedEnv("keel-backup-env", {
    vault,
    item: BACKUP_VAULT_ITEM,
    ...sealedFields(BACKUP_VAULT_ITEM, resolveSecretRefs(BACKUP_VAULT_ITEM, BACKUP_SECRET_ENV)),
    ageRecipient,
  });
  new KeelBackup(
    "keel-backup",
    {
      host: sshTarget,
      config: renderBackupConfig({
        target: INSTALLATION.backup,
        set: backupSet(SERVICES),
        image: RESTIC_IMAGE,
      }),
      sealedEnv: { ciphertext: sealed.ciphertext, plaintextHash: sealed.plaintextHash },
      secretsPath: BACKUP_SECRETS_PATH,
      sshArgs,
    },
    // The target's own host is in the file keel-hosts.service resolved from —
    // named rather than addressed, on the router's own USB share — so the
    // backup's first run wants that name in /etc/hosts before it calls
    // getaddrinfo on it.
    { dependsOn: [hostsUnit] },
  );
}
