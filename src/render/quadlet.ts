import { NETWORKS } from "../config/keel";
import {
  certSyncName,
  dependencyNames,
  metricsSecretsPath,
  type Roles,
  secretsPath,
  type ServiceSpec,
} from "../config/spec";
import { dedent, file, merge, type Tree } from "./tree";

/** The two networks by kind — see `NETWORKS` for what each field is pinned for. */
export const NETWORK_NAMES = {
  internal: NETWORKS.internal.name,
  open: NETWORKS.open.name,
} as const;

export const NETWORK_INTERFACES = {
  internal: NETWORKS.internal.interface,
  open: NETWORKS.open.interface,
} as const;

/**
 * One source for a network quadlet's content, whichever layer writes it: the
 * image ships the pair under `/usr/share/containers/systemd` so they exist
 * before any service does, and the Pulumi layer shadows them at
 * `/etc/containers/systemd` — quadlet reads `/etc` first — so a network change
 * lands with a `pulumi up` instead of a reboot.
 *
 * Deliberately NOT `Internal=true`. Under netavark, internal means no
 * connectivity to anything off the bridge — the host included — so a port
 * published to the host's loopback forwards into a wall and the service is
 * unreachable by the proxy that exists to front it. The property `Internal`
 * was reached for — a container earns its way off the host — belongs to the
 * packet filter instead: `keel.nft`'s forward chain drops by policy and
 * accepts only the open bridge by name, which denies the internal network
 * egress without severing it from its own host.
 *
 * `DisableDNS` is load-bearing: Pi-hole runs on the host's network and answers
 * `:53` on every address, the bridge gateway included, so aardvark-dns cannot
 * bind its own resolver there and every container on the network fails to
 * start. Nothing needs it — services reach each other through ports published
 * on the host's loopback, and a container resolves the outside world through
 * the host's non-loopback fallback resolvers, which podman copies in.
 */
export function networkQuadlet(name: string, kind: keyof typeof NETWORKS): string {
  const network = NETWORKS[kind];
  return dedent(`
    [Network]
    NetworkName=${name}
    InterfaceName=${network.interface}
    Subnet=${network.subnet}
    Gateway=${network.gateway}
    DisableDNS=true
  `);
}

/** Network definitions live in the image: they exist before any service does. */
export function renderNetworks(): Tree {
  return merge(
    file(
      `/usr/share/containers/systemd/${NETWORK_NAMES.internal}.network`,
      networkQuadlet(NETWORK_NAMES.internal, "internal"),
    ),
    file(
      `/usr/share/containers/systemd/${NETWORK_NAMES.open}.network`,
      networkQuadlet(NETWORK_NAMES.open, "open"),
    ),
  );
}

/**
 * Render a service's quadlet. Pure, so the properties that matter — secrets
 * referenced by path and never inlined, egress-restricted by default, bound to
 * loopback — are unit-testable without a device.
 *
 * `EnvironmentFile=` is why services stay quadlets rather than becoming Docker
 * API containers: the API has no equivalent, so environment would have to be
 * passed inline and every secret value would land in Pulumi state.
 *
 * Memory caps are deliberately absent. `Slice=` places the service in the right
 * tier; the actual `MemoryHigh`/`MemoryMax` come from the profile drop-in the
 * boot-time generator stages, so exactly one mechanism owns those numbers.
 *
 * `extraEnv` is what the entry's own `setup` composed from the installation — an
 * issuer URL, a cookie domain, anything naming the zone. It stays a parameter
 * because this function knows no installation, and a value that named one could
 * not live in the committed catalog. The two halves must not overlap; a variable
 * set from both places would have two owners and no rule for which wins.
 *
 * `roles` is the deployed set's resolved capabilities, and it is what makes the
 * *derived* edges reach the boot as well as the deploy. A service with
 * `auth: "oidc"` is ordered after the identity provider by `dependencyNames`,
 * and with no roles here that edge would exist in Pulumi's graph and nowhere on
 * the device — the first deploy would start them in the right order and every
 * reboot after it would race, the client crash-looping through `Restart=always`
 * until the issuer answered. Left empty this is exactly `spec.dependsOn`, which
 * is what a renderer with no deployment in hand can honestly say.
 */
export function renderQuadlet(
  spec: ServiceSpec,
  extraEnv: Record<string, string> = {},
  roles: Roles = {},
): string {
  const egress = spec.egress ?? "internal";
  // Both env files are derived from the entry rather than passed in, which is
  // what keeps this a pure function of a spec: what a deploy writes and what a
  // golden pins cannot differ, because there is one reading of the declaration.
  const envFiles = [secretsPath(spec), metricsSecretsPath(spec)].filter((path) => path !== null);

  const env = { ...spec.env };
  for (const [name, value] of Object.entries(extraEnv)) {
    if (name in env) throw new Error(`${spec.name} sets ${name} in both its spec and extraEnv`);
    env[name] = value;
  }

  // The unit this container pulls in: the certificate sync its `certificates`
  // declaration implies. Ordering alone would be inert — nothing else starts a
  // one-shot, so without wanting it the first start is a start with no
  // certificate.
  const sync = certSyncName(spec);
  const wants = sync === null ? [] : [`${sync}.service`];

  // `boot-complete.target` is reached only after greenboot's health checks pass,
  // and greenboot can roll the system back to the previous image. A service that
  // started before the verdict could have already written to /var/lib — which
  // survives the rollback while the code that wrote it does not. Ordering after
  // the verdict is what keeps a rejected image from leaving data behind.
  const after = [
    "network-online.target",
    "boot-complete.target",
    ...(envFiles.length > 0 ? ["keel-secrets.service"] : []),
    // The same edges the deploy layer orders its resources by — the written ones
    // and the derived ones alike — so a boot starts these in the order the first
    // deploy did. Ordering only: `After=` on a unit that fails does not hold this
    // one down, and on a unit that does not exist it is inert, which is what a
    // dependency the plan already refused would be.
    ...dependencyNames(spec, roles).map((name) => `${name}.service`),
    // A unit is pulled in so that it runs before this one, which is ordering as
    // well as a dependency — `Wants=` alone would let both start at once.
    ...wants,
  ];
  // Deliberately no line for a mount unit: quadlet derives `RequiresMountsFor=`
  // from every absolute `Volume=` source, which is `Requires=` plus `After=` on
  // the unit that mounts it, so a share's ordering is already in the `Volume=`
  // line and a second copy of it here would be one more name to get wrong.

  const container = [
    `ContainerName=${spec.name}`,
    `Image=${spec.image}`,
    // Host networking publishes nothing: the service binds the host's ports
    // directly, and a PublishPort alongside it would be a conflict, not a no-op.
    // The `.network` suffix is load-bearing: it points at the network QUADLET,
    // which makes the generator start the network's own unit before this one. A
    // bare name asks podman for a network that already exists — and nothing
    // else ever creates it, so the container fails with "network not found".
    ...(egress === "host"
      ? ["Network=host"]
      : [
          `Network=${NETWORK_NAMES[egress]}.network`,
          `PublishPort=127.0.0.1:${spec.port}:${spec.port}`,
        ]),
    ...(spec.mounts ?? []).map((mount) => `Volume=${mount}`),
    // systemd splits an unquoted Environment= value on whitespace, so a value
    // carrying any — a JSON blob, a sentence — is quoted, with the characters
    // the quoting itself claims escaped. A plain value stays bare: quoting
    // everything would churn each already-deployed unit for no behavior change.
    ...Object.entries(env).map(([key, value]) =>
      /[\s"\\]/.test(value)
        ? `Environment=${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        : `Environment=${key}=${value}`,
    ),
    // The entry's own sealed environment, and then the account the deploy
    // generated for it on another service. Two files because two resources write
    // them and they rotate for different reasons; podman reads both.
    ...envFiles.map((path) => `EnvironmentFile=${path}`),
    ...(spec.cmd ? [`Exec=${spec.cmd}`] : []),
    ...(spec.healthCmd
      ? [
          `HealthCmd=${spec.healthCmd}`,
          // Tighter than podman's 30s default, because this interval is also how
          // long the start job sits waiting for the first passing check.
          "HealthInterval=5s",
          "HealthStartPeriod=10s",
          "Notify=healthy",
        ]
      : []),
  ];

  // podman refuses a bind mount whose host directory does not exist, and a
  // service's own data directory exists nowhere until something makes it — a
  // restored host has it from the snapshot, a fresh one has nothing. Only the
  // service's own /var/lib/<name> is created; any other mount source missing
  // (a NAS mount unit, another service's tree) is a real error to surface.
  const ownData = `/var/lib/${spec.name}`;
  const makesOwnDir = (spec.mounts ?? []).some((mount) => mount.split(":")[0] === ownData);

  // `TimeoutStartSec=600` on every unit, because a first start pulls the image
  // inside `ExecStart` and systemd's default 90 seconds is shorter than a pull
  // over a home uplink onto a Pi: the pull is killed mid-download, the unit fails,
  // and `Restart=always` retries into a half-warm cache until it happens to fit.
  // With a health check the same wait also covers the first-run work a service
  // does before it answers — Pi-hole builds its blocklists.
  return dedent(`
    [Unit]
    Description=${spec.description}
    After=${after.join(" ")}
    Wants=${["network-online.target", ...wants].join(" ")}

    [Container]
    ${container.join("\n    ")}

    [Service]
    ${makesOwnDir ? `ExecStartPre=/usr/bin/mkdir -p ${ownData}\n    ` : ""}Slice=keel-${spec.memory.tier}.slice
    Restart=always
    RestartSec=10
    TimeoutStartSec=600

    [Install]
    WantedBy=multi-user.target
  `);
}

/** Where the quadlet lands. `/etc` because Pulumi owns it, not the image. */
export function quadletPath(spec: ServiceSpec): string {
  return `/etc/containers/systemd/${spec.name}.container`;
}
