/**
 * A per-source rate limit on the ports that answer the internet, as a
 * packet-filter file the deploy layer writes.
 *
 * Its own base chain, one priority ahead of the image's `input`, because a
 * drop-in's rules would otherwise land at the end of that chain, after the
 * `@world_tcp` accept they are meant to precede. A drop in any base chain is
 * final and an accept is not, so this chain can only take traffic away from
 * `input`, never admit something it would refuse.
 *
 * New connections only, so a long-lived stream is never counted, and only from
 * outside the LAN and the mesh, which reach the same ports all day. An IPv6
 * source counts per /64, because a single host can rotate through its own
 * prefix. What is over the rate is dropped by the kernel before Traefik sees
 * it; a meter entry expires a minute after it was made, and the limiter with
 * it.
 */

/** `30-`, after the forward rules, before the per-service ports; only for reading order. */
export const NFT_GUARD_PATH = "/etc/keel/nft.d/30-world-guard.nft";

/**
 * New connections a second a source may open. A NetBird client joining opens
 * a dozen requests in four seconds, multiplexed over far fewer connections.
 */
export const GUARD_RATE = 10;
/** The burst on top of the rate, in connections. */
export const GUARD_BURST = 30;

/**
 * `world` is whether the deployed set opens anything to the internet. Without
 * it the file is still written, holding only a comment, for the reason the
 * forward file gives: a deletion runs after the reload, which would re-read the
 * copy still on disk.
 */
export function renderNftGuard(world: boolean): string {
  if (!world) {
    return [
      "# Nothing on this host answers the internet, so there is nothing to guard.",
      "# Written rather than removed: a deletion would run after the reload.",
      "",
    ].join("\n");
  }
  const limit = `limit rate over ${GUARD_RATE}/second burst ${GUARD_BURST} packets`;
  const meters = [
    ["tcp dport @world_tcp", "flood4", "ip saddr"],
    ["udp dport @world_udp", "flood4", "ip saddr"],
    ["tcp dport @world_tcp", "flood6", "ip6 saddr and ffff:ffff:ffff:ffff::"],
    ["udp dport @world_udp", "flood6", "ip6 saddr and ffff:ffff:ffff:ffff::"],
  ].map(([port, set, key]) => `        ${port} add @${set} { ${key} ${limit} } counter drop`);
  return [
    "table inet keel {",
    "    set flood4 { type ipv4_addr; flags dynamic, timeout; timeout 1m; size 65535; }",
    "    set flood6 { type ipv6_addr; flags dynamic, timeout; timeout 1m; size 65535; }",
    "    chain world_guard {",
    "        type filter hook input priority filter - 1; policy accept;",
    '        iif "lo" accept',
    "        ct state != new accept",
    "        ip saddr @lan4 accept",
    "        ip saddr @mesh4 accept",
    "        ip6 saddr @mesh6 accept",
    ...meters,
    "    }",
    "}",
    "",
  ].join("\n");
}
