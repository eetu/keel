import { FALLBACK_DNS } from "../config/keel";
import { file, merge, type Tree } from "./tree";

/**
 * A resolver this machine can use before it is one.
 *
 * The address comes from DHCP, where the router pins it to this machine's MAC,
 * so nothing here needs to know it. But the router may also point the LAN here
 * for DNS, which means a DHCP-derived resolv.conf sends this box to itself —
 * fine once Pi-hole is up, and a deadlock on a blank card, where the first thing
 * needed is to pull Pi-hole's image.
 *
 * So resolv.conf is static and NetworkManager is told to leave it alone.
 * Loopback first, so normal queries go through Pi-hole and its filtering; the
 * fallback covers the gap, with a short timeout because that gap is every query
 * until the container starts.
 *
 * The hostname is not here: it belongs to the board rather than to the image,
 * and `keel-firstboot` sets it from `keel.conf` on the ESP.
 */
export function renderNetwork(): Tree {
  return merge(
    file("/etc/NetworkManager/conf.d/00-keel-dns.conf", "[main]\ndns=none\n"),
    // The board's global IPv6 address, made a property of its hardware rather
    // than of its installation.
    //
    // NetworkManager's default is stable-privacy (RFC 7217): an identifier
    // derived from a per-host secret, so it survives reboots and changes the
    // moment the machine is reinstalled — or the moment the operating system
    // under it is replaced. That is the wrong property for an address other
    // things point *at*. A board reached over IPv6 from outside has its address
    // written down in two places no deploy can reach: the DNS record peers
    // resolve, and the pinhole the router opens for it. Both silently stop
    // matching when the identifier moves, and the failure is invisible from the
    // board — everything outbound keeps working, and only inbound connections,
    // which nobody makes from here, are refused.
    //
    // `eui64` derives it from the MAC instead, so it is the same address on a
    // reinstall, the same address after a migration to another OS, and
    // computable by hand from a label on the hardware. What it gives up is the
    // privacy of not broadcasting the MAC inside the address, which matters for
    // a laptop that roams between networks and not at all for a board bolted to
    // one LAN — where being predictable is the entire point.
    file(
      "/etc/NetworkManager/conf.d/10-keel-ipv6.conf",
      "[connection]\nipv6.addr-gen-mode=eui64\n",
    ),
    // Joined, not dedented: dedent takes its indent from the least-indented line,
    // and an interpolated list has none — leaving every other line indented, which
    // glibc ignores.
    file(
      "/etc/resolv.conf",
      [
        "# Managed by keel. Pi-hole when it is up; the fallback covers the rest.",
        "nameserver 127.0.0.1",
        ...FALLBACK_DNS.map((server) => `nameserver ${server}`),
        "options timeout:1 attempts:2",
        "",
      ].join("\n"),
    ),
  );
}
