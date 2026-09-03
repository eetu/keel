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
