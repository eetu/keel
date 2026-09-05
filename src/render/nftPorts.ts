import { type Catalog, type Ingress, type ServiceSpec, subdomainOf } from "../config/spec";

/**
 * The ports a host's services need, as one drop-in for the packet filter.
 *
 * Same additive mechanism `keel-firstboot` uses for the address ranges (see
 * `firstboot.ts`): the file re-opens `table inet keel` and re-declares a set with
 * elements, and nft merges those elements into the set the image already
 * declared. Nothing here restates the table, the chains or the rules — a rule
 * already matches `@lan_tcp`, and this is what puts something in it.
 *
 * **Merging is the trap.** `nft -f` on a re-declared set adds; it never removes.
 * Deleting a port from this file leaves it in the kernel's set until the whole
 * table is built again from scratch. `nftables.service` is what does that: its
 * `ExecReload` re-reads `/etc/sysconfig/nftables.conf`, whose first act is
 * `flush table inet keel`, followed by the base table and the
 * `/etc/keel/nft.d/*.nft` glob — so a reload, not a re-apply of this file, is
 * what closes a port. The flush is keel's table alone: netavark keeps a table of
 * port forwards for every running bridge container and NetBird one for the
 * mesh, and a `flush ruleset` would take both, leaving every published port dead
 * until its container restarted.
 *
 * **One file for the host, not one per service**, and that follows from the same
 * two facts. Pulumi performs deletions after updates, so a per-service file
 * belonging to a retired service is still on disk when the reload re-reads the
 * glob: the reload run to close that port re-admits it instead, and it stays open
 * until the next reload or reboot. `nft -f` merges, so the per-service files were
 * never independent of each other anyway — what the kernel gets is their union
 * either way. Writing the union as one file makes retiring a service an *update*
 * of the file the reload reads, in the same run that reloads.
 *
 * **And the file is always written, even when it names no port at all.** A body
 * of "nothing" that became an absent file would be a *deletion*, which is the
 * exact shape the one file exists to remove: retiring the last service that
 * answers the network would delete this file after the reload, and the reload run
 * to close those ports would re-read the copy still on disk and re-admit every
 * one of them. A set that admits nothing says so, in a file.
 */
export const NFT_SERVICES_PATH = "/etc/keel/nft.d/50-services.nft";

/** Set name in the image's table, keyed the way `ingress` is written. */
const SETS: readonly (readonly [keyof Ingress, string])[] = [
  ["lanTcp", "lan_tcp"],
  ["lanUdp", "lan_udp"],
  ["meshTcp", "mesh_tcp"],
  ["meshUdp", "mesh_udp"],
  ["worldTcp", "world_tcp"],
  ["worldUdp", "world_udp"],
];

/** Sorted and deduplicated, so writing the same ports twice is not a diff. */
function elements(ports: readonly number[]): string {
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`not a port: ${port}`);
    }
  }
  return [...new Set(ports)].sort((a, b) => a - b).join(", ");
}

/**
 * One service's contribution, or `null` when it asks for nothing — which is most
 * services, since everything behind Traefik is reached through Traefik's own
 * port. Per-spec and pure, so what a single entry opens is readable on its own
 * (`yarn spec`) and testable without the set it is deployed beside.
 */
export function renderNftPorts(spec: ServiceSpec): string | null {
  const declared = SETS.filter(([key]) => (spec.ingress?.[key]?.length ?? 0) > 0);
  if (declared.length === 0) return null;

  const lines = [
    `# ${spec.name}`,
    "table inet keel {",
    ...declared.map(
      ([key, set]) =>
        `    set ${set} { type inet_service; elements = { ${elements(spec.ingress![key]!)} } }`,
    ),
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The whole deployed set's contributions as the one file's body — always a body,
 * never an absence, for the reason in the header.
 *
 * Sorted by name rather than left in catalog order: the body is what the reload's
 * trigger hashes, so an entry moving within the catalog would otherwise rewrite
 * the file and reload the packet filter for no change in what it admits.
 *
 * The comparison is on code units and not `localeCompare`, which collates by the
 * runtime's default locale: ICU orders `apple` before `Zebra`, code units order
 * `Zebra` first, and either would put the machine's environment inside a rendered
 * file and inside the state value hashed from it. A renderer's output depends on
 * its argument and nothing else.
 */
/**
 * The proxy's port, opened to the internet, when a deployed vhost has opted out
 * of the allowlist — and only then.
 *
 * A name in `publicHosts` is answerable from anywhere or it is nothing: Traefik
 * matches on the Host header, so the route already stops guarding that vhost by
 * source address, and a packet filter that still dropped :443 from the internet
 * would leave the opt-out true in the proxy and false one layer down. The
 * coordinator of a mesh is the case this exists for.
 *
 * Derived rather than declared, because the proxy's entry is committed: an
 * `ingress` line there would open 443 to the world for every clone, including
 * the ones whose `publicHosts` is empty and whose 443 should answer the LAN
 * alone.
 */
export function publicProxyIngress(
  catalog: Catalog,
  publicHosts: readonly string[],
): ServiceSpec | null {
  const proxy = catalog.proxy?.spec;
  if (proxy === undefined) return null;
  const exposed = catalog.services.some((spec) => {
    const subdomain = subdomainOf(spec);
    return subdomain !== null && publicHosts.includes(subdomain);
  });
  if (!exposed) return null;
  return {
    ...proxy,
    ingress: { ...proxy.ingress, worldTcp: [...(proxy.ingress?.worldTcp ?? []), proxy.port] },
  };
}

export function renderNftServices(specs: readonly ServiceSpec[]): string {
  const blocks = [...specs]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(renderNftPorts)
    .filter((rules) => rules !== null);
  return blocks.length === 0
    ? "# Nothing in the deployed set answers the network itself.\n"
    : blocks.join("");
}
