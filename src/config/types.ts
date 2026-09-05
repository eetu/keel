/**
 * Which slice a service lands in, and so what happens to it under pressure.
 * `core` is the set whose failure takes the LAN with it: the resolver, the
 * proxy, and the identity provider everything else authenticates against.
 */
export type Tier = "core" | "apps";

/**
 * What one service costs, and how that cost moves with the board. It lives on
 * the entry that declares the service, so a cap is read next to the workload it
 * is a claim about.
 */
export type ServiceMemory = {
  /** Hard cap (`MemoryMax`), MiB, on the smallest profile. */
  max: number;
  /**
   * Soft throttle (`MemoryHigh`), MiB. Defaults to 75% of `max`. Set it
   * explicitly for a service whose steady state sits well under its ceiling.
   */
  high?: number;
  tier: Tier;
  /**
   * Resident size actually observed on the fleet, MiB. Recorded so a cap can be
   * checked against reality instead of taste — see the budget tests, which hold
   * every cap to at least 1.5x its measurement. A cap below that fires during
   * normal operation; far above it, nothing fires at all and the board simply
   * runs out of memory.
   */
  measuredMb?: number;
  /**
   * True when extra RAM genuinely buys something — a scanner, a packer, a
   * transcoder. Everything else keeps its cap on every board, because a bigger
   * ceiling does not make an idle reverse proxy faster.
   */
  scales?: boolean;
};

/**
 * A file a service needs whose content names the installation, so no renderer
 * can derive it from the entry alone. An entry's `setup` returns them.
 */
export type ServiceFile = {
  /** Distinguishes the resource; the path decides where it lands. */
  name: string;
  path: string;
  content: string;
  mode?: string;
  /**
   * Whether changing it restarts the service. False for configuration the
   * service watches and re-reads by itself.
   */
  restarts?: boolean;
};

/**
 * A random value the deploy draws for a service, which no person ever types: a
 * signing secret, a store's encryption key, a session cookie key. It is
 * generated where it is used and sealed for the board in the same run, so it is
 * in no vault and in nobody's clipboard — the same trade the metrics account
 * makes, for the same reason.
 *
 * `bytes` and `encoding` are two different facts and both belong to whoever
 * reads the value: 32 bytes are 64 hexadecimal characters to one server and 44
 * base64 ones to another, and a server that wants a 32-character AES key wants
 * 16 bytes spelled as hex.
 */
export type GeneratedSecret = {
  /** How many random bytes are drawn. */
  bytes: number;
  /** How the value is spelled where the service reads it. */
  encoding: "hex" | "base64";
  /**
   * Refuse to replace or delete it. For a value that is the only key to data
   * already written: a fresh one leaves an unreadable store rather than a
   * credential to re-issue, so replacing it has to be a decision somebody takes
   * by removing this line, never one a changed input takes on their behalf.
   */
  protect?: boolean;
};

/**
 * A file whose body carries values the deploy generated — a server's
 * configuration with key material in it, which makes the whole file a secret
 * rather than a `ServiceFile`.
 *
 * The body is stated as a function of those values rather than as a string,
 * because a generated value exists only once its resource has run: the entry
 * says what the file looks like and never sees what is in it, the deploy layer
 * draws the values, seals the result for the board and writes the blob. So an
 * entry stays as pure as every other one, and no plaintext is ever a `Tree`
 * entry, a renderer's output or a resource this repository writes to a device.
 */
export type ServiceSecretFile = {
  /** Distinguishes the resource; the path decides where it lands. */
  name: string;
  /**
   * Where the decrypted file lands. Under `/etc/secrets`, because that is where
   * `keel-secrets.service` opens `*.age` and nowhere else — a blob outside it is
   * one nothing ever decrypts, and a container that starts without its file.
   */
  path: string;
  /** The values the body needs, under the names the body reads them by. */
  generate: Record<string, GeneratedSecret>;
  /**
   * The body, given those values. Pure, and called once per deploy inside the
   * apply that resolves them.
   */
  content: (generated: Record<string, string>) => string;
};

export type Network = {
  lanCidr: string;
  domain: string;
  /**
   * The LAN address every vhost resolves to: the board the proxy runs on. One
   * per installation rather than one per host, because a name points at the
   * proxy wherever the service behind it is deployed — Pi-hole's local records
   * and the public A records both carry this value and nothing else.
   */
  lanAddress: string;
};

/** The NetBird overlay ranges. A connected peer is treated like a LAN client. */
export type Mesh = {
  v4: string;
  v6: string;
  /** UDP, reachable directly and forwarded by the router — cannot be proxied. */
  stunPort: number;
  /**
   * The agent's WireGuard port. Open it and peers hole-punch directly; leave it
   * null and every mesh connection falls back to the relay, which runs on this
   * same host. Client flag, firewall rule and router forward must all agree.
   */
  agentWireguardPort: number | null;
};

/**
 * The SMB share the restic repository lives on. Installation data: it names one
 * network's NAS, so it lives in `installation.ts` and is read by `src/infra/` alone.
 */
export type BackupTarget = {
  /**
   * SMB server: an address, or a name. A name the LAN's own DNS does not know —
   * a router that hands its own USB share a new address by DHCP being the case
   * this exists for — is resolved by `keel-hosts.service`, which broadcasts a
   * NetBIOS NAME QUERY for it at boot and every five minutes and writes the
   * answer into `/etc/hosts`, which the backup's own `getaddrinfo` call reads.
   */
  host: string;
  /** Share name on that server, without the leading slashes. */
  share: string;
  /** Directory inside the share holding the restic repository. */
  repoDir: string;
  /**
   * Kernel CIFS mount options, comma-separated and credential-free: the dialect
   * and the security mode the server speaks. The credentials are added from the
   * host's sealed env file, and never appear here or in Pulumi state.
   */
  mountOptions: string;
};

/**
 * An SMB share on this installation's network, and where a host puts it.
 *
 * Installation data for the same reason `BackupTarget` is: it names one
 * network's NAS. What turns one into a mount unit is a deployed service binding
 * a path under `mountpoint` — a share nothing mounts is a fact about the network
 * that costs the host nothing.
 */
export type Share = {
  /**
   * Where it is mounted on the host. The mount unit's name is systemd's escaping
   * of this path, and a service binding a path under it is ordered after that
   * unit by quadlet's own `RequiresMountsFor=` — so two shares may not land on
   * one mountpoint.
   *
   * Canonical on this image, which means `/var/mnt/music` and not `/mnt/music`:
   * `/mnt` is one of the ostree symlinks into `/var`, and systemd refuses a mount
   * unit whose `Where=` resolves through one. `mountedShares` refuses the
   * symlinked spelling and names the canonical one.
   *
   * Letters, digits, `_`, `.` and `:` only — `/var/mnt/media_nas`, never
   * `/var/mnt/media-nas`. Everything else, a dash and a space included, systemd
   * escapes to `\xNN`, and a unit name holding a backslash cannot be carried to
   * the host: ssh joins its arguments and the remote shell eats it. Refused with
   * the rename spelled out rather than deployed as a name nothing wrote.
   */
  mountpoint: string;
  /**
   * SMB server: an address, or a name. A name the LAN's own DNS does not know —
   * a router that hands its own USB share a new address by DHCP being the case
   * this exists for — is resolved by `keel-hosts.service`, which broadcasts a
   * NetBIOS NAME QUERY for it at boot and every five minutes and writes the
   * answer into `/etc/hosts`, which `mount.cifs` reads through `getaddrinfo`.
   */
  host: string;
  /** Share name on that server, without the leading slashes. */
  share: string;
  /**
   * Kernel CIFS mount options, comma-separated and credential-free: the dialect
   * and the security mode the server speaks. The login is added by the mount
   * unit as a `credentials=` path, so it appears neither here nor in the unit.
   *
   * Credential-free is enforced, not asked for: this string lands verbatim in a
   * mode-644 unit that `systemctl cat` prints, so `password=`, `user=`,
   * `credentials=` and `guest` are refused, and so is any whitespace — a space
   * is a second word on the unit's `Options=` line and a newline a second
   * directive. `ro` and `rw` come from `readOnly` and are refused here too: the
   * kernel honours the last occurrence, and these options come last.
   */
  mountOptions: string;
  /**
   * Mounted `ro`, and with the vault's read-only login rather than its
   * read-write one. Deliberately without a default: which of two NAS accounts a
   * host authenticates as is a decision, not something for this type to take
   * quietly on behalf of whoever adds the share.
   */
  readOnly: boolean;
};

/**
 * The mail relay a service submits invitations and notifications through.
 *
 * One reader today — the password manager — and it stays here rather than moving
 * onto that entry because the entry is *committed*: a stranger's relay is a
 * different host, port and security mode, so the entry may name none of them.
 */
export type SmtpRelay = {
  host: string;
  port: number;
  /** Vaultwarden's vocabulary: "starttls", "force_tls" or "off". */
  security: string;
};

/**
 * Everything that belongs to one installation rather than to the fleet, in one
 * object: gitignored, and the only place a *committed* service entry may reach
 * for the house. Such an entry reads what it needs in its own `setup`, which is
 * handed this object — so the entry stays generic and the value stays here.
 *
 * **A field here is what the fleet or several services need**, and that is the
 * whole admission rule: the network, the mesh, the vault's name, the backup
 * target, the shares, the mail relay. What one service needs is that service's,
 * and belongs in its own entry — a parameter of its `setup` if the entry is
 * committed, stated outright if the entry is in the gitignored local catalog,
 * which is installation configuration already. A field with exactly one reader,
 * whose reader is a local entry, is a value that took the long way round through
 * a shared type; twenty such services would be twenty fields every other
 * installation has to fill in and no clone can use.
 */
export type Installation = {
  /**
   * The 1Password vault every secret field is read out of. The item and field
   * names live on the catalog entries, because a stranger creates the same ones;
   * which vault holds them is a fact about one installation, and a default in
   * the deploy program would be one house's vault name that every other deploy
   * read without being told.
   */
  vault: string;
  network: Network;
  mesh: Mesh;
  smtp: SmtpRelay;
  /**
   * Subdomains that opt out of the `internal-only` allowlist. Public 443 is
   * forwarded so the NetBird coordinator is reachable from anywhere, and Traefik
   * matches on Host header rather than source IP — so every other vhost would
   * answer a stranger who sets the header. Adding a name here is the only way to
   * expose it, and there is almost never a reason to.
   */
  publicHosts: readonly string[];
  backup: BackupTarget;
  /**
   * The SMB shares this network has. A host mounts the ones something it deploys
   * actually binds, so this is the whole list rather than one board's — and an
   * installation with no NAS states an empty one.
   */
  shares: readonly Share[];
  /**
   * The boards, keyed by name. The key is the Pulumi stack name and the
   * ssh_config alias the deploy layer dials, so a host has no name field of its
   * own: wherever code needs the name it has the key.
   */
  hosts: Record<string, Host>;
};

/**
 * One board. What it runs is the catalog, or the subset it names; everything
 * else here is what sizes and reaches it.
 */
export type Host = {
  /**
   * The board's RAM, MiB. It picks the memory profile the deploy layer sizes
   * that host's services from — `selectProfile` here and the boot-time generator
   * in the image implement the same rule, so a board whose figure is wrong here
   * still lands in the profile its own MemTotal chooses for the slices.
   */
  ramMb: number;
  /**
   * Public half of the age identity at /etc/keel/age.key on that host, which is
   * placed there once by hand. Not a secret: it only lets you encrypt *to* the
   * host. Absent means the host takes no secrets yet.
   */
  ageRecipient?: string;
  /**
   * Public keys admitted for the admin account. Not secrets, but they live in
   * the gitignored installation file because they identify particular machines.
   *
   * Written into `keel.conf` on the card's ESP at card-build time (see
   * `src/cli/card-config.ts`), not baked into the OCI image itself: the image
   * is generic, and the first boot has to be reachable regardless — sshd
   * refuses passwords and root.
   */
  adminKeys?: readonly string[];
  /**
   * The catalog entries this host deploys, by name. Absent means the whole
   * catalog, which is what a board with nothing beside it runs; present means
   * exactly these, so `[]` is a board that deploys nothing. A name no entry is
   * called stops the plan rather than deploying less: a typo here would
   * otherwise be a service that silently never arrives.
   *
   * Selection, never ordering — the graph orders whatever is selected, and a
   * dependency this list leaves out is refused rather than pulled in.
   */
  services?: readonly string[];
  /**
   * Nightly restic snapshots to `INSTALLATION.backup`. Off unless stated: the
   * backup deploys something no catalog entry declares, wanting the share
   * already standing and three vault fields of its own, so a first deploy is not
   * asked for either.
   */
  backup?: boolean;
};
