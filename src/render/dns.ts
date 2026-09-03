import { UNBOUND } from "../config/keel";
import { PROFILES, resolveMemory } from "../config/profiles";
import { dedent, file, type Tree } from "./tree";

/**
 * Cache sizes derived from the service's own memory cap rather than stated
 * separately, because the two have to agree and nothing would make them.
 *
 * Unbound treats these as ceilings and fills them, so asking for more cache than
 * the cgroup allows means being OOM-killed once the caches warm up — which the
 * old repo's 50 MB + 100 MB against a 64 MB cap would eventually have done. A
 * quarter of the cap for RRsets and an eighth for messages keeps the documented
 * 2:1 ratio and leaves the process itself the rest.
 */
function cacheSizes(): { msgMb: number; rrsetMb: number } {
  // Sized against the smallest profile: the config is baked into the image while
  // the profile is chosen at boot, so it has to hold on the tightest board.
  const { maxMb } = resolveMemory("unbound", PROFILES[0]);
  return { msgMb: Math.floor(maxMb / 8), rrsetMb: Math.floor(maxMb / 4) };
}

/**
 * Unbound listens on loopback only; Pi-hole is its sole client and the only
 * thing the LAN talks to.
 */
function unboundConfig(): Tree {
  const { msgMb, rrsetMb } = cacheSizes();

  return file(
    // conf.d, not unbound.conf.d: the latter is included by nothing, so the
    // config is silently ignored and unbound runs package defaults — on :53,
    // where it collides with Pi-hole and leaves its upstream pointing at nothing.
    "/etc/unbound/conf.d/keel.conf",
    dedent(`
      server:
          interface: 127.0.0.1
          port: ${UNBOUND.port}
          do-ip4: yes
          do-ip6: no
          do-udp: yes
          do-tcp: yes

          access-control: 127.0.0.0/8 allow

          # No root-hints directive: the package's compiled-in defaults are used
          # instead. Root servers change roughly once a decade, and the weekly
          # image rebuild refreshes the unbound package — and whatever hints ship
          # in it — anyway, so there is nothing here worth a build-time fetch.

          # DNSSEC comes from the package's own root-auto-trust-anchor-file
          # drop-in; declaring auto-trust-anchor-file again here conflicts with it.

          hide-identity: yes
          hide-version: yes

          msg-cache-size: ${msgMb}m
          rrset-cache-size: ${rrsetMb}m
          cache-min-ttl: 300
          cache-max-ttl: 86400

          num-threads: 1
          so-rcvbuf: 1m

          prefetch: yes
          prefetch-key: yes

          harden-glue: yes
          harden-dnssec-stripped: yes
          harden-below-nxdomain: yes
          use-caps-for-id: yes
          val-clean-additional: yes

          verbosity: 0
          log-queries: no
          log-replies: no

          # RFC 6762 / RFC 6303 special-use zones, never recursed. Matter and
          # Thread devices query service.arpa and .local for DNS-SD; an immediate
          # NXDOMAIN stops border routers retrying hard enough to lose track of
          # devices, which a SERVFAIL from failed recursion does not.
          local-zone: "service.arpa." static
          local-zone: "local." static
    `),
  );
}

/**
 * The resolver every board carries. The SELinux label its port needs is
 * `src/render/selinux.ts`.
 *
 * The LAN's own resolver is not here. It is a Pulumi service, so a blank card
 * boots to a bare machine and the configuration layer installs what runs on it —
 * a card that flashes fast, and a setup that is reproduced rather than baked. The
 * cost is stated plainly: until `pulumi up` runs the LAN resolves through the
 * router's fallback with no blocking and no split-DNS. The board itself resolves
 * the same way, which is what lets podman pull that service's image at all.
 */
export function renderDns(): Tree {
  return unboundConfig();
}
