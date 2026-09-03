import { NETWORK_INTERFACES } from "./quadlet";
import { dedent, file, merge, type Tree } from "./tree";

/** The one bridge whose containers may originate traffic off the host. */
const OPEN_BRIDGE = NETWORK_INTERFACES.open;

/**
 * A dedicated `table inet keel` rather than firewalld or ufw. NetBird installs
 * its own nftables rules on the same host, and separate tables is what keeps the
 * two from clobbering each other — with ufw, chain ordering against NetBird was
 * the first thing to suspect whenever mesh peers connected but reached nothing.
 *
 * The table is complete and admits almost nothing: policy drop, the traffic a
 * machine needs to exist on a network at all, SSH — and then port sets that
 * ship empty. A lookup against an empty set matches nothing, so an image with no
 * `keel.conf` is closed by construction rather than by an accurate list. The
 * elements arrive at boot in `/etc/keel/nft.d/*.nft`, where `keel-firstboot`
 * writes the address ranges and Pulumi writes the ports a service needs — nft
 * merges a re-declared set additively, so each file adds to the table without
 * restating it.
 *
 * IPv6 ingress is deliberately mesh-only. An ISP-delegated prefix rotates, so
 * there is no stable LAN v6 source to match on; v6 clients reach services through
 * the mesh, which has fixed addressing. That is why `lan4` has no v6 counterpart.
 *
 * The forward chain carries no interface rule: routing mesh traffic onto the LAN
 * is a property of the peer a host is, not of the image, and arrives the same way
 * through `/etc/keel/nft.d`.
 */
function ruleset(): Tree {
  return file(
    "/usr/lib/keel/nftables/keel.nft",
    dedent(`
      table inet keel {
          set lan4 { type ipv4_addr; flags interval; }
          set mesh4 { type ipv4_addr; flags interval; }
          set mesh6 { type ipv6_addr; flags interval; }

          set lan_tcp { type inet_service; }
          set lan_udp { type inet_service; }
          set mesh_tcp { type inet_service; }
          set mesh_udp { type inet_service; }
          set world_tcp { type inet_service; }
          set world_udp { type inet_service; }

          chain input {
              type filter hook input priority filter; policy drop;

              iif lo accept
              ct state established,related accept
              ct state invalid drop

              icmp type { echo-request, destination-unreachable, time-exceeded, parameter-problem } accept
              icmpv6 type { echo-request, destination-unreachable, time-exceeded, parameter-problem, nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert, mld-listener-query } accept

              # DHCP, which conntrack cannot cover: the request leaves from 0.0.0.0
              # for the broadcast address before an address exists, and the reply is
              # broadcast too, so there is nothing for \`established,related\` to
              # match. Without it the box comes up with a link and no network.
              udp sport 67 udp dport 68 accept
              # \`meta nfproto ipv6\`, not \`ip6\`: in an inet table \`ip6\` must be
              # followed by a header field, and the syntax error takes the whole
              # ruleset down with it.
              meta nfproto ipv6 udp sport 547 udp dport 546 accept
              # NetBIOS name answers, for the same reason: keel-hosts asks by
              # broadcast and the node answers from its own address, so conntrack
              # pairs nothing and the reply would die here. LAN only, and only from
              # the name service's port.
              ip saddr @lan4 udp sport 137 accept

              # The one port the image itself opens. A board that answers nothing
              # else is still a board someone can get into and fix.
              ip saddr @lan4 tcp dport 22 accept
              ip saddr @mesh4 tcp dport 22 accept
              ip6 saddr @mesh6 tcp dport 22 accept

              ip saddr @lan4 tcp dport @lan_tcp accept
              ip saddr @lan4 udp dport @lan_udp accept
              ip saddr @mesh4 tcp dport @mesh_tcp accept
              ip saddr @mesh4 udp dport @mesh_udp accept
              ip6 saddr @mesh6 tcp dport @mesh_tcp accept
              ip6 saddr @mesh6 udp dport @mesh_udp accept

              tcp dport @world_tcp accept
              udp dport @world_udp accept
          }

          chain forward {
              type filter hook forward priority filter; policy drop;

              ct state established,related accept

              # This chain is where a container earns internet access, which is
              # why the podman networks are not marked Internal (netavark's
              # internal severs the host too, killing loopback-published ports).
              # Only the open bridge may originate outbound traffic; netavark's
              # own table handles the masquerade. keel-internal's bridge matches
              # nothing here and falls to the drop policy.
              iifname "${OPEN_BRIDGE}" accept
          }
      }
    `),
  );
}

export function renderNftables(): Tree {
  return merge(
    ruleset(),
    // One file for both the start and the reload, and it rebuilds keel's table
    // alone. `nft -f` merges into what exists, so a port that left a drop-in
    // would stay in the kernel's set without the flush — and the stock reload's
    // `flush ruleset` empties every table on the box, netavark's port forwards
    // and NetBird's included, so every bridge container running at the time
    // loses its published port until something re-adds the rule. Declaring the
    // empty table first makes the flush valid on a boot where nothing exists yet;
    // the whole file is one transaction, so the filter is never briefly open. A
    // glob that matches nothing is not an error (nft >= 0.9.1), so a machine
    // with an empty drop-in directory loads the base table and stops there.
    file(
      "/etc/sysconfig/nftables.conf",
      dedent(`
        table inet keel {}
        flush table inet keel
        include "/usr/lib/keel/nftables/keel.nft"
        include "/etc/keel/nft.d/*.nft"
      `),
    ),
    // The stock unit's reload is `flush ruleset` followed by the file; the file
    // now carries its own, narrower flush, so the reload is the file alone.
    file(
      "/usr/lib/systemd/system/nftables.service.d/50-keel.conf",
      dedent(`
        [Service]
        ExecReload=
        ExecReload=/sbin/nft -f /etc/sysconfig/nftables.conf
      `),
    ),
  );
}
