/**
 * The image's own configuration: what is true of every keel host, whatever
 * network it boots into.
 *
 * Committed, unlike `installation.ts`. The image is one generic artefact,
 * so everything under `src/render/` reads this file, `profiles.ts`, `services.ts`,
 * `versions.ts` and `types.ts` — and nothing installation-specific. A value that
 * differs between installations reaches a host another way: `keel.conf` on the
 * ESP for its identity, Pulumi for everything with an API.
 */

/**
 * The account the project creates. `keel-firstboot` makes it and puts it in
 * `ADMIN_GROUP` on a board handed a `keel.conf`, and the card's
 * `KEEL_ADMIN_KEY` lines land in its `authorized_keys` — so it belongs to the
 * project rather than to a person, and no stranger's image carries anyone's
 * login.
 *
 * Nothing matches on the name: sshd admits the group and the sudoers drop-in
 * grants the group. Editing this line therefore decides which account comes into
 * existence, not who may log in, and a board's existing member of that group is
 * unaffected by the edit.
 */
export const ADMIN_USER = "keel";

/**
 * The group that is allowed in and allowed sudo. `wheel` rather than a group of
 * keel's own: every distro this image could be built from already creates it,
 * `useradd -G` therefore needs no `groupadd` ahead of it, and `%wheel` is the
 * line sudo's own documentation and every operator expects to find.
 *
 * Naming the group in one place is what keeps sshd's `AllowGroups`, the sudoers
 * drop-in and the account `keel-firstboot` creates from disagreeing — a board
 * where they do is a board nobody can log in to.
 */
export const ADMIN_GROUP = "wheel";

/**
 * The two podman networks every container service attaches to. Which one a
 * service joins decides whether it can leave the host: the packet filter's
 * forward chain accepts only the open bridge, so the internal one reaches its
 * own host and nothing beyond it.
 *
 * Every field is pinned rather than left to podman. The interface name is what
 * the packet filter matches on, and netavark's default (`podman1`, `podman2`, …)
 * depends on creation order. The subnet and gateway are what a service on a
 * bridge sees the host *as*: traffic the proxy sends into a published port
 * arrives from the gateway, so a service that trusts an identity header from the
 * proxy whitelists the gateway — a fact worth stating once here rather than
 * copying an address podman happened to pick.
 */
export const NETWORKS = {
  internal: {
    name: "keel-internal",
    interface: "keel-int0",
    subnet: "10.89.0.0/24",
    gateway: "10.89.0.1",
  },
  open: {
    name: "keel-open",
    interface: "keel-open0",
    subnet: "10.89.1.0/24",
    gateway: "10.89.1.1",
  },
} as const;

/**
 * Unbound: the recursive resolver, loopback-only, upstream for Pi-hole.
 *
 * Cache sizes are deliberately absent — they are derived from the service's
 * `MemoryMax` in `src/render/dns.ts`, because stating them independently is how
 * you end up asking for more cache than the cgroup will allow.
 */
export const UNBOUND = { port: 5335 };

/**
 * What this machine asks when Pi-hole cannot answer — a freshly flashed card, or
 * any moment the container is down. It cannot be Unbound: resolv.conf has no way
 * to name a port, and Unbound listens on its own.
 *
 * A router that hands this machine out as the LAN's resolver would otherwise
 * leave a blank card asking itself, getting nothing, and unable to pull the very
 * images that would make it answerable. Public anycast resolvers, so the image
 * carries no address belonging to any particular network.
 */
export const FALLBACK_DNS: readonly string[] = ["9.9.9.9", "149.112.112.112"];

/**
 * Kernel modules refused outright. `install <mod> /bin/false` is what actually
 * blocks a load — a bare `blacklist` line only suppresses alias-driven autoload.
 * Nothing in the fleet uses AF_ALG kernel crypto, so denying it costs nothing
 * and closes the algif family of local-privilege-escalation paths for good.
 */
export const MODPROBE_DENY: readonly string[] = ["algif_aead", "algif_skcipher"];

/**
 * Journal is volatile: logs live in RAM and are lost on reboot. On these boards
 * that is the point — persistent journals are the single largest source of
 * avoidable writes to the boot media.
 */
export const JOURNAL_MAX_USE = "64M";
