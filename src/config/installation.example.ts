/**
 * Copy this file to `src/config/installation.ts` and fill in your values.
 *
 * One object: everything a service needs is on its catalog entry, and the values
 * the whole fleet or several services need are here — the network, the mesh, the
 * vault's name, the mail relay, the backup target, the shares, and the boards
 * themselves. A committed entry reaches them through its own `setup`; a service
 * of your own states what only it needs in its own entry in `services.local.ts`,
 * which is gitignored and is this installation's already. So this file does not
 * grow with the catalog.
 *
 * Read by the Pulumi layer and the card tooling, never by a renderer: the image
 * is generic, and what it holds comes from `src/config/keel.ts`. Non-secret
 * configuration only — addresses, domains, image references. Secret *values*
 * never appear here; they live in the vault and reach a host as age ciphertext.
 */

import { type Installation } from "./types";

export const INSTALLATION: Installation = {
  /**
   * The 1Password vault holding every field the catalog names — `cloudflare`,
   * `oauth2-proxy`, `kanidm` and `vaultwarden`, plus `restic` and `cifs` for a
   * host that backs up or mounts a share. Nothing creates them for you: each
   * field is read by the resource that seals it, as the service needing it is
   * deployed, so a missing one fails that service by name once the deploy
   * reaches it.
   */
  vault: "homelab",

  network: {
    lanCidr: "192.168.1.0/24",
    domain: "example.com",
  },

  /**
   * The mesh's own ranges, which have to say the same thing the card's
   * `keel.conf` does: both become elements of the sets the packet filter matches
   * against. Generate the v6 half rather than copying it — a ULA out of
   * `fd00::/8` is only unique because each installation picks its own, and two
   * fleets sharing a prefix collide the day they are joined.
   */
  mesh: {
    v4: "100.64.0.0/16",
    v6: "fd2b:9e41:7c05::/64",
    stunPort: 3478,
    agentWireguardPort: 51820,
  },

  /**
   * The mail relay Vaultwarden submits invitations and 2FA mail through. The
   * credentials are vault fields; only the relay's coordinates live here.
   */
  smtp: {
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
  },

  publicHosts: [],

  /**
   * The SMB share holding the restic repository, for a host with `backup: true`.
   * `host` may be a name, but only if the board resolves it — an address asks
   * nothing of DNS. The credentials are vault fields (`cifs` item,
   * `readwrite_username` / `readwrite_password`), never values here.
   */
  backup: {
    host: "192.168.1.2",
    share: "backups",
    repoDir: "keel-restic",
    mountOptions: "vers=3.1.1,sec=ntlmsspi",
  },

  /**
   * The network's SMB shares. A host mounts the ones something it deploys binds
   * a path under: a service declares `mounts: ["/var/mnt/music:/music:ro"]`, and
   * that line plus the entry below are what create the mount unit — quadlet
   * orders the service after the mount from the `Volume=` source on its own. A
   * share nothing mounts is not an error and gets no unit — the deploy simply
   * never asks the vault for a login to it.
   *
   * `/var/mnt` rather than `/mnt`, because `/mnt` is an ostree symlink into it
   * and systemd will not mount onto a path that resolves through one; and
   * `media_nas` rather than `media-nas`, because systemd escapes a dash to
   * `\x2d` and a unit name holding a backslash does not survive the trip to the
   * host.
   *
   * The login is the `cifs` item's `readonly_*` or `readwrite_*` pair, chosen by
   * `readOnly` here; the values are read at deploy time and never appear in this
   * file, in the unit, or in Pulumi state. State an empty list if you have no
   * NAS.
   *
   * `mount.cifs` is image content, so a board whose booted image predates it
   * cannot mount a share with a login at all — the deploy probes for the helper
   * and stops rather than mounting one without. See the trap in CLAUDE.md before
   * deploying a host's first share.
   *
   * `host` accepts a name as well as an address: a NAS that gets its own address
   * handed to it by a router's DHCP server, rather than one this fleet assigns,
   * is worth naming rather than addressing — `keel-hosts.service` resolves the
   * name by NetBIOS broadcast at boot and every five minutes, so a moved node
   * reaches every mount without anyone editing this file.
   */
  shares: [
    {
      mountpoint: "/var/mnt/music",
      host: "192.168.1.2",
      share: "music",
      mountOptions: "vers=3.1.1,sec=ntlmsspi",
      readOnly: true,
    },
  ],

  /**
   * The boards, keyed by name. The key is both the Pulumi stack name and the
   * ssh_config alias the deploy layer dials; `adminKeys` becomes the
   * `KEEL_ADMIN_KEY` lines of the host's `keel.conf` (`yarn card-config <host>`),
   * and `ageRecipient` is what Pulumi seals secrets to.
   *
   * Nothing here reaches the image: one artefact boots every board, and a host's
   * own identity arrives from `keel.conf` on its ESP.
   */
  hosts: {
    raspi: {
      // What the board actually has, MiB: `free -m` on it, rounded to the nominal
      // size. It picks the memory profile this host's services are capped from.
      ramMb: 8192,
      // Public half of the age identity generated on the board — run
      // `age-keygen` there and record its output here, not a value you invent.
      ageRecipient: "age1yourage00000000000000000000000000000000000000000000000000000",
      adminKeys: ["ssh-ed25519 AAAA... your key"],
      // No `services` list: the host runs the whole catalog, which is what a
      // board with nothing beside it does. Name a subset only for a board that
      // is one of several.
      //
      // `backup` is deliberately absent: it deploys something no catalog entry
      // declares, wanting an SMB share already standing at `INSTALLATION.backup`
      // and three vault fields of its own, so a first deploy asks for neither.
      // Set it once there is somewhere for the snapshots to land.
    },
  },
};
