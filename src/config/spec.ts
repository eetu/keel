/**
 * The shape of a service declaration, the pure readings of one, and the roles a
 * set of them resolves to.
 *
 * The catalog is the list; this is what one entry in it is. Everything that
 * consumes a spec depends on this file rather than on the list — the renderers,
 * the deploy layer, and the adapters that speak one product's dialect. Nothing
 * here imports the catalog, so reaching a single service's shape never means
 * pulling in the table of every service.
 *
 * A role is how one entry reaches another without naming it: the proxy that
 * routes to everything, the identity provider clients trust, the gate a route is
 * sent through. `roles()` resolves them by presence, so what an entry depends on
 * is a capability some other entry declares rather than a string that has to
 * match.
 */

import {
  type Installation,
  type Network,
  type ServiceFile,
  type ServiceMemory,
  type ServiceSecretFile,
} from "./types";

export type Egress =
  /** No route off the host. The default: a service earns internet access. */
  | "internal"
  /** Reaches the internet. State why in a comment on the entry. */
  | "open"
  /**
   * The host's own network stack. For a service that has to answer the LAN
   * directly or see real client addresses — which a bridge would rewrite. It
   * opts out of the egress restriction entirely, so state why on the entry.
   */
  | "host";

/**
 * How a service establishes who is on the other end of a request.
 *
 * - `oidc` — the service runs its own OIDC client against the fleet's identity
 *   provider, and does the flow itself with a client id and a secret of its own.
 * - `edge` — the proxy asks the forward-auth gate before it routes anything, so
 *   the service is only ever reached by a request that already carries an
 *   identity.
 * - `open` — no gate keel adds. The route's IP allowlist is still on it, and an
 *   allowlist is not authentication: it says where a request came from and
 *   nothing at all about who sent it.
 */
export const AUTH_MODES = ["oidc", "edge", "open"] as const;

export type Auth = (typeof AUTH_MODES)[number];

/**
 * The ports a service needs the packet filter to admit, by source.
 *
 * The table ships with empty sets and a drop policy, so a port is closed until
 * something names it. Naming it here is what makes the deploy layer write the
 * drop-in that opens it — and removing the entry is what closes it again.
 *
 * `lan` and `mesh` are the address sets `keel.conf` fills; `world` is the open
 * internet and wants a sentence on the entry saying why. Almost nothing does:
 * the LAN reaches services through Traefik, and a peer that is not on the LAN
 * reaches them through the mesh.
 */
export type Ingress = {
  lanTcp?: readonly number[];
  lanUdp?: readonly number[];
  meshTcp?: readonly number[];
  meshUdp?: readonly number[];
  worldTcp?: readonly number[];
  worldUdp?: readonly number[];
};

/**
 * Where a secret value is read from: a field on the service's own vault item, or
 * an item and a field together when the credential belongs to someone else. An
 * OIDC client secret is the second kind — the identity provider generates it and
 * keeps it with its own credentials, so the client names both halves.
 */
export type SecretRef = string | { item: string; field: string };

/**
 * The certificate store a proxy fills, and what it takes to read one out of it.
 *
 * A store is not an interface. The proxy keeps every certificate it holds in one
 * file of its own format, and there is no hook to run when one is renewed — so
 * the store carries the program that parses it, as TEXT rather than as a path,
 * because it is written into `/etc`, whose label systemd will not execute. The
 * interpreter runs it as an argument instead, which needs no label at all.
 */
export type CertificateStore = {
  /** The product that fills it. The units that read it describe themselves by it. */
  product: string;
  /** The file. A path unit watches it, so a renewal reaches whoever reads it. */
  path: string;
  /** What the program is passed to — `/usr/bin/python3`, not a shebang. */
  interpreter: string;
  /**
   * How long the program waits for the store's first certificate before giving
   * up. The proxy answers well before it has issued anything, so a reader's copy
   * is a wait rather than a look — and the unit that runs the program is given a
   * start timeout from this, so the program's own message is what fails rather
   * than systemd's kill.
   */
  settleSeconds: number;
  /** The program, for one reader's destination directory and journal prefix. */
  extract: (into: { dir: string; journalTag: string; settleSeconds: number }) => string;
};

/**
 * What a route file needs that the entry it is written for cannot state: the zone
 * it answers in, which vhosts opt out of the allowlist, and the gate a gated
 * route asks. All three belong to the deployment rather than to the service.
 */
export type RouteContext = {
  /** The zone the vhost lives in. Passed in: a renderer knows no installation. */
  domain: string;
  /** Subdomains that opt out of the allowlist. Empty is the safe default. */
  publicHosts?: readonly string[];
  /** The gate an `auth: "edge"` route is sent through, with the entry that is it. */
  gate?: Claimed<GateRole>;
};

/**
 * One router on an entry's vhost, for a service whose paths are not all one
 * upstream — gRPC on a cleartext HTTP/2 backend, a REST API on the same port, a
 * dashboard on another container's.
 *
 * Declaring any replaces the single router a vhost otherwise derives, and every
 * one of them carries that vhost's middlewares: the allowlist and the gate are
 * properties of the name a request arrives on rather than of the router that
 * happens to match it, so a second router is never a way past either.
 *
 * The priority is stated because Traefik's own default is the length of the
 * rule — an order nobody wrote down, which changes when a path is added to a
 * match and silently hands a catch-all what the API was answering.
 */
export type Router = {
  /** Suffix on the entry's name; `""` is the entry's own name. */
  name: string;
  /** Matched in addition to the vhost's `Host()` — a Traefik rule fragment. */
  match?: string;
  /** Which port this router forwards to; the entry's own by default. */
  port?: number;
  /** `h2c` for a cleartext HTTP/2 backend, which gRPC needs. */
  scheme?: "h2c";
  /** Higher wins. Traefik's default is the rule's length, so state it. */
  priority: number;
  /**
   * `"internal"` keeps the LAN allowlist on this router even where the vhost has
   * opted out of it — the one direction a router may differ from its vhost.
   *
   * A router may be stricter than the name it answers on and never looser, which
   * is what keeps "who may reach this" a property of the vhost: nothing added
   * here can widen it. What it is for is a path on an internet-facing vhost that
   * has no business being answered from the internet — netbird's `/api/setup`,
   * the unauthenticated call that claims the coordinator's one account, is the
   * case it exists for.
   */
  reach?: "internal";
};

/**
 * A route to a service the board does not run.
 *
 * No image, no unit, no memory cap, no firewall rule and no backup: a
 * `RemoteSpec` is the route, the LAN record and the check, and one day the
 * public record — nothing the board itself owns. `upstream` is a full URL
 * (`http(s)://host:port`) and the only field that names another machine.
 * An entry for something the board runs is a `ServiceSpec`, not this.
 */
export type RemoteSpec = {
  name: string;
  description: string;
  subdomain: string;
  /** `http(s)://host:port` — the only field naming another machine. */
  upstream: string;
  auth: Auth;
  publicDns?: boolean;
};

/**
 * The service that terminates TLS and routes to every other one.
 *
 * Swapping the proxy is writing a second value of this shape: the deploy layer
 * asks the role where a route lands and what is in it, so nothing outside the
 * adapter that declares one spells a proxy-shaped string.
 */
export type ProxyRole = {
  /** The unit anything ordered against the proxy names. */
  unit: string;
  /**
   * Where its certificates land, for the services that cannot be handed one
   * through the proxy itself. A proxy that exposes no store leaves this unset,
   * and a service declaring `certificates` against it is then an error rather
   * than a sync that quietly finds nothing.
   */
  certificateStore?: CertificateStore;
  /** One entry's route file — service or remote — or null for a service with no vhost. */
  route: (spec: ServiceSpec | RemoteSpec, context: RouteContext) => string | null;
  /** Where that file lands, in whichever directory the proxy watches. */
  routePath: (spec: ServiceSpec | RemoteSpec) => string;
};

/**
 * The OIDC issuer every client in the fleet trusts.
 *
 * The issuer is the single most provider-specific line in the repository —
 * Kanidm's is a path under its own origin named for the client — so a client
 * asks the role for one rather than composing a URL of its own.
 */
export type IdentityRole = {
  /** The issuer an OAuth2 client asks, from the provider's origin and the client id. */
  issuer: (origin: string, clientId: string) => string;
};

/**
 * The edge session gate a route with `auth: "edge"` is sent through.
 *
 * Five URL facts and one header list, all of them the gate's: the proxy queries
 * the first, turns the answer's status into a fetch of the second, the page that
 * comes back submits itself to the third, the identity provider is handed the
 * fourth as the client's registered redirect URI, and the fifth is what the proxy
 * copies onto the request it goes on to route.
 */
export type GateRole = {
  /** Where the proxy sends its forward-auth query. */
  forwardAuth: string;
  /** The sign-in page a refusal is turned into, carrying where to return to. */
  challenge: (returnTo: string) => string;
  /**
   * The status the gate refuses with, which the proxy has to catch. A proxy that
   * lets it through shows the browser a bare error and no login page at all.
   */
  challengeStatus: number;
  /** What the sign-in page submits itself to, under the gate's own origin. */
  submit: (origin: string) => string;
  /** The redirect URI the OIDC client is registered with. */
  callback: (origin: string) => string;
  /** Headers the proxy copies from the gate's answer onto the routed request. */
  responseHeaders: readonly string[];
};

/**
 * The service failures are posted to. One fact: the topic, because the address
 * is derived — the image's poller runs on the host and posts to the loopback
 * port the entry publishes, so nothing here names a zone or an address.
 */
export type AlertRole = {
  /** The ntfy topic the board's failures land in; what a phone subscribes to. */
  topic: string;
};

/**
 * The metrics hub a client of it gets an account on.
 *
 * Two facts and nothing about which product it is: where the superuser's login
 * sits on the hub's own vault item, and the API paths a PocketBase speaks. The
 * paths are here rather than in the provider so that the provider spells no
 * product's API into itself — it is "create an account on the hub", and which
 * URLs that is remains the entry's to say.
 */
export type MetricsRole = {
  /** Vault field names on the hub's own item holding the superuser login. */
  superuser: { user: string; password: string };
  /** PocketBase paths, so the provider spells no product's API into itself. */
  api: MetricsApi;
};

/** The four calls creating an account on the hub takes. */
export type MetricsApi = {
  /** Answers once the hub is serving; polled before anything is created. */
  health: string;
  /** Exchanges the superuser's login for a token the other three carry. */
  superuserAuth: string;
  /** The account collection: looked up by email, created or patched by id. */
  users: string;
  /** The monitored machines, each of which the account is assigned to. */
  systems: string;
};

/**
 * An account on the metrics hub, created by the deploy for the service that
 * reads it.
 *
 * `env` names the two variables *the application* reads the login out of,
 * because that is the application's vocabulary and not the deployment's — the
 * same reason a template states nothing about a service's bind or its database
 * path. What the deployment owns is the rest: the account exists on whichever
 * entry claims the metrics role, its password is generated where it is sealed,
 * and it reaches the container as an env file of its own.
 */
export type MetricsAccount = {
  /** What the account may do on the hub. A page that draws graphs asks for `readonly`. */
  role: "readonly" | "user";
  /** The variables the application reads the account's email and password out of. */
  env: { user: string; password: string };
};

/**
 * The paths claiming a service's first account takes, so the provider that
 * claims it spells no product's API into itself — the same division `MetricsApi`
 * draws. Which URLs this is remains the entry's to say; the provider's subject
 * is "claim the first account and keep the token it answers with".
 */
export type BootstrapApi = {
  /** GET — answers once the service is serving, and says whether it is still unclaimed. */
  instance: string;
  /** The field in that answer that is true while no account exists. */
  requiredKey: string;
  /** POST — claims the account and mints the token every later call carries. */
  setup: string;
  /**
   * GET — the account the token belongs to. It is the liveness check as well as
   * the lookup: a token the service no longer accepts is a 401 here, and one it
   * does accept names the account, so one call answers both questions.
   */
  accounts: string;
  /** The upstream identity providers the service's own broker federates to. */
  connectors: string;
  /** The scheme the `Authorization` header carries the token under. */
  authScheme: string;
};

/**
 * An upstream identity provider registered on the service's own broker, so that
 * signing in to it is the fleet's single sign-on.
 *
 * The issuer is not here: it comes from whichever entry claims the identity
 * role, asked for the client this is registered as, the same way every other
 * OIDC client in this repository gets one. What the entry states is the two
 * halves the role cannot know — the name the connector is found again by, and
 * where the identity provider filed the client secret it generated.
 */
export type BootstrapConnector = {
  /** The connector's name on the service. It is matched by this and never by id. */
  name: string;
  /** The client id it is registered under at the identity provider. */
  clientId: string;
  /** Item and field the identity provider's generated client secret sits on. */
  secret: { item: string; field: string };
};

/**
 * The first account on a service that refuses to be configured until it has one,
 * claimed by the deploy rather than by a person at a wizard.
 *
 * The account is the mesh's owner and the token it answers with is what every
 * later call authenticates as, so this is the one declaration whose product is a
 * credential that has to leave the provider. `token` names where a hand-minted
 * one is read from when the account already exists and this resource has none —
 * the only path a person walks, and the one the provider's error names.
 */
export type BootstrapAccount = {
  /**
   * The owner's display name on the account. Not its address: that is
   * `deployedAccountEmail`, derived from the entry's name in the fleet's zone
   * for the same reason the hub account's is — an address typed into a catalog
   * is one that can disagree with itself, and on the far side that is a second
   * account rather than an error.
   */
  name: string;
  /** How long a minted token lives, in days. The API caps this at 365. */
  tokenDays: number;
  /** Item and field a hand-minted token is read from. Names only, never a value. */
  token: { item: string; field: string };
  /** The paths this takes, in the service's own dialect. */
  api: BootstrapApi;
  /** The upstream identity provider to federate to, if the service brokers one. */
  connector?: BootstrapConnector;
};

/**
 * The overlay's account-wide settings — the ranges every peer is numbered out
 * of and the policies that apply to all of them.
 *
 * Composed by the entry's `setup` from the installation rather than typed here,
 * because the ranges already exist on `Installation.mesh` and are read by the
 * proxy's allowlist and by the coordinator's own configuration file. A second
 * copy on the entry is a copy that can disagree with those, and a mesh numbered
 * out of a range the allowlist does not admit is a peer that connects and
 * reaches nothing.
 */
export type MeshSettings = {
  /** The overlay's v4 range, in CIDR. */
  networkRange: string;
  /** The DNS suffix every peer's own name is published under. */
  dnsDomain: string;
  /**
   * Whether an SSO-enrolled peer has to re-authenticate in a browser on a
   * schedule. Off where the identity provider's vhost admits the LAN and the
   * mesh alone: a peer away from home cannot reach the login it would be sent
   * to, so the expiry is a peer that strands rather than one that re-signs in.
   */
  peerLoginExpirationEnabled: boolean;
  /** Whether the routing peer answers DNS for the networks it carries. */
  routingPeerDnsResolutionEnabled: boolean;
  /** Whether group membership is read out of the login's own token claims. */
  jwtGroupsEnabled: boolean;
  /** The groups such a claim may name. Empty while the reading above is off. */
  jwtAllowGroups: readonly string[];
};

/**
 * A key a device enrols with, which is the whole of how a peer joins without a
 * browser.
 *
 * The plaintext is shown once, by the call that creates it — so it is a secret
 * output of the resource that made it and lives in state under the stack
 * passphrase, the same trade the account's own token makes. Nobody copies it
 * anywhere: the board's agent will read it from there, and a person recovering
 * a lost phone reads it out of the same place.
 */
export type MeshSetupKey = {
  name: string;
  /** `reusable` for a key more than one device enrols with, `one-off` for a single peer. */
  type: "reusable" | "one-off";
  /** Seconds. The server caps this at a year and refuses less than a day. */
  expirySeconds: number;
  /** How many peers may enrol with it; 0 is unlimited. */
  usageLimit: number;
  /** Groups every peer enrolled with it lands in, by name. */
  autoGroups: readonly string[];
  /** An ephemeral peer is reaped once it has been offline for ten minutes. */
  ephemeral: boolean;
};

/**
 * A network the routing peer carries for everyone else — what makes a connected
 * phone able to reach the LAN rather than only the boards on the overlay.
 */
export type MeshRoute = {
  /** Groups the highly-available copies of one route; it is also the route's name. */
  networkId: string;
  description: string;
  /** The range being carried, in CIDR. `0.0.0.0/0` is an exit node. */
  network: string;
  /** Which peers are offered the route, by group name. */
  groups: readonly string[];
  /** Lowest wins where two routes carry the same range. */
  metric: number;
  /** Whether the routing peer rewrites the source address on the way out. */
  masquerade: boolean;
  enabled: boolean;
  /**
   * Advertise the route without applying it, so a client takes it only after
   * selecting it. This is what makes an exit node opt-in: without it every peer
   * would route all of its traffic through the house the moment it connects.
   */
  skipAutoApply?: boolean;
};

/**
 * DNS for the peers: a domain sent to a nameserver on the overlay rather than
 * to whatever the peer's own network handed it.
 *
 * The address is not declared. It is the routing peer's *mesh* address, which
 * the coordinator assigns, so it is resolved from the peer at deploy time — a
 * peer deleted and re-enrolled gets a new one, and a pinned literal would send
 * every peer's queries into a hole.
 */
export type MeshNameservers = {
  name: string;
  description: string;
  /** The port the nameserver answers on. */
  port: number;
  /** Which peers use it, by group name. */
  groups: readonly string[];
  /** The domains sent to it. Empty only for a group that resolves everything. */
  domains: readonly string[];
  /** Whether it resolves every domain rather than the ones listed. */
  primary: boolean;
  searchDomainsEnabled: boolean;
  enabled: boolean;
};

/**
 * The board's own enrolment — what makes the machine that coordinates the
 * overlay a peer of it, and so the thing every route below is carried by.
 *
 * The name it registers under is not here: it is `routingPeer`, which the routes
 * and the DNS group already resolve against. One string, stated once, because
 * two would be a peer enrolled under a name nothing names — a mesh that connects
 * and routes nothing, which looks exactly like a working one.
 */
export type MeshAgent = {
  /**
   * Which of `setupKeys` the board enrols with, by name. The key's plaintext is
   * a secret output of the resource that created it, so it reaches the board
   * sealed and is never copied anywhere a person could read it.
   */
  setupKey: string;
  /**
   * The port WireGuard binds, or null for the client's own default.
   *
   * Composed from the installation, which is also where the packet filter's
   * world-facing rule and the router's forward come from — the three have to
   * agree or a peer quietly relays through the coordinator instead of meeting
   * this board directly. That failure is invisible: the mesh works, and every
   * byte of it crosses the busiest machine in the house twice.
   */
  wireguardPort: number | null;
};

/**
 * The account state a deploy holds on a service it claimed: the state that
 * lives behind that service's own API rather than in a file on the board.
 *
 * It is composed by the entry's `setup` because most of it is the house — the
 * overlay's ranges, the LAN it carries, the domain its DNS answers for — and
 * the rest is the entry's own vocabulary. Nothing here names a product: the
 * shape is groups, keys, routes and nameservers, which is what an overlay is,
 * and the resources it becomes are the bridged provider's in `src/infra/`.
 */
export type MeshState = {
  /**
   * The peer that carries the routes and answers DNS, by the name it enrols
   * under. It is not derived from the host: the agent's own `--hostname` flag
   * decides what the coordinator calls this board, so the two are one string
   * stated once rather than two that can disagree.
   */
  routingPeer: string;
  /**
   * How that peer comes to exist, when it is this board's own agent. Absent
   * where the routing peer is another machine, which the deploy then has no
   * way to enrol and does not try to.
   */
  agent?: MeshAgent;
  settings: MeshSettings;
  /** Groups to create, by name. The overlay's own `All` is built in and never declared. */
  groups: readonly string[];
  setupKeys: readonly MeshSetupKey[];
  routes: readonly MeshRoute[];
  nameservers: readonly MeshNameservers[];
};

/** A role and the entry that claims it — which is what a consumer of one needs. */
export type Claimed<R> = { spec: ServiceSpec; role: R };

/** The capabilities a deployment resolves to, each claimed by at most one entry. */
export type Roles = {
  proxy?: Claimed<ProxyRole>;
  identity?: Claimed<IdentityRole>;
  gate?: Claimed<GateRole>;
  alerts?: Claimed<AlertRole>;
  metrics?: Claimed<MetricsRole>;
};

/**
 * Where the image's poller posts a failure: the sink's published loopback port
 * and its topic. Loopback because the poller is the host's — a bridge service
 * publishes there and a host-network one binds there — and the proxy is not in
 * the path, so an alert about the proxy still arrives.
 */
export function alertUrl(alerts: Claimed<AlertRole>): string {
  return `http://127.0.0.1:${alerts.spec.port}/${alerts.role.topic}`;
}

/** Those roles and the set they were resolved from. */
export type Catalog = Roles & {
  /** Everything being deployed, for a reading the roles do not cover. */
  services: readonly ServiceSpec[];
  /** Vhosts to a machine the board does not run. Empty for most deploys. */
  remotes: readonly RemoteSpec[];
};

/**
 * Certificate files a service reads but cannot obtain: the proxy holds the only
 * certificate, and this is where a copy of it belongs. Declaring the directory
 * is what creates the one-shot that fills it and the path unit that re-runs on a
 * renewal — the deploy layer derives both, so no entry names a unit.
 */
export type CertificateFiles = {
  /** Where chain.pem and key.pem land. The service reads them from here. */
  dir: string;
};

/**
 * The installation-shaped half of one service's configuration: environment that
 * names the zone, files whose content does. Both are optional, and a service
 * that needs neither declares no `setup` at all.
 */
export type ServiceSetup = {
  /** Merged into the quadlet beside the entry's own `env`; they must not overlap. */
  env?: Record<string, string>;
  files?: readonly ServiceFile[];
  /**
   * Files whose body carries key material this deploy generates. Separate from
   * `files` because they are a different resource on the device — an age blob
   * the boot-time decrypt opens — and because their body is a function of values
   * that do not exist until the deploy has drawn them.
   */
  secretFiles?: readonly ServiceSecretFile[];
  /**
   * State the deploy holds behind the service's own API rather than on the
   * board — for a service the deploy claimed the first account of, and only for
   * one, since the token that authorises every call is that account's.
   *
   * It arrives through `setup` for the reason the files above do: almost all of
   * it is the installation — the overlay's ranges, the LAN it carries, the
   * domain its DNS answers for — and an entry composes those from the house it
   * is handed rather than restating them.
   */
  mesh?: MeshState;
};

/**
 * What an entry's `setup` is handed: itself, the house, the roles resolved across
 * what is being deployed, and a way to build any service's public URL in the
 * zone it is being deployed into.
 *
 * `self` is why no entry looks itself up, and the roles are why no entry looks
 * another up by name.
 */
export type SetupContext = {
  /** The entry this setup belongs to. */
  self: ServiceSpec;
  installation: Installation;
  catalog: Catalog;
  /** `https://<subdomain>.<domain>` — this entry's own vhost unless told otherwise. */
  origin: (spec?: ServiceSpec) => string;
};

export type ServiceSpec = {
  /** Also the container name, unit name, subdomain and drop-in key. */
  name: string;
  description: string;
  /**
   * Digest-pinned, or a tag for an image built from a branch — an app whose CI
   * pushes `main` on every merge. The reference itself says which: one carrying
   * `@sha256:` moves when someone edits it, and the edit is the review; anything
   * else is resolved to a digest when Pulumi runs, so a moving tag still produces
   * a visible diff, a restart that follows from it, and a previous digest in
   * state to roll back to. A published product is pinned, because its digest is
   * a fact nobody here has to build, and a committed entry is held to that.
   */
  image: string;
  /** Bound on loopback; Traefik is the only listener that faces the LAN. */
  port: number;
  /**
   * The slice it runs in and what it may use there. The deploy layer prices it
   * against the board's profile and writes the drop-in beside the quadlet.
   */
  memory: ServiceMemory;
  /**
   * Environment variable name -> vault field. The values are read at deploy
   * time, sealed for the target host and written as ciphertext; the decrypted
   * file's path is derived by `secretsPath`, so it is never stated twice.
   */
  secretEnv?: Record<string, SecretRef>;
  /** Vault item holding those fields. Defaults to the service name. */
  vaultItem?: string;
  /**
   * Ports the packet filter admits to this service. Only a service that answers
   * the network itself needs any: everything behind Traefik is reached through
   * Traefik's own 443.
   */
  ingress?: Ingress;
  /** `null` for a service with no web surface. Defaults to `name`. */
  subdomain?: string | null;
  /**
   * The routers on this entry's vhost, where one is not enough: an entry whose
   * paths divide between upstreams states them here and the derived single
   * router is replaced by exactly what it says. Exactly one of them omits its
   * `match` and takes everything the others do not.
   */
  routers?: readonly Router[];
  /**
   * The service speaks TLS on its own port, so the proxy reaches it over https.
   * For one that has no plaintext listener at all — the certificate is its own,
   * on loopback, and never leaves the host.
   */
  tlsUpstream?: boolean;
  /** Resolvable in public DNS. Points at the LAN IP; exposure is Traefik's call. */
  publicDns?: boolean;
  /**
   * Who is allowed to reach it. Required, and deliberately without a default: a
   * default here would be a decision about who may talk to a new service, taken
   * silently by this type rather than by whoever adds the entry.
   */
  auth: Auth;
  egress?: Egress;
  /**
   * Quadlet `Volume=` lines, e.g. `/var/mnt/media:/media:ro`.
   *
   * A host path is canonical or the plan refuses it: `/mnt` is an ostree symlink
   * into `/var/mnt`, and quadlet's derived `RequiresMountsFor=` does not chase
   * symlinks even though podman does — so the symlinked spelling silently drops
   * the dependency on the unit that mounts the data.
   *
   * That derived `RequiresMountsFor=` is the whole of a service's ordering
   * against a share: it is `Requires=` plus `After=` on the unit that mounts the
   * source, so a share is a `mounts` line here and an entry in the installation's
   * `shares`, and nothing names the mount unit.
   */
  mounts?: readonly string[];
  /**
   * Other services in the catalog that have to be *running* before this one is
   * started. Ordering, never selection: a name here does not pull an entry into
   * a deployment, and a host whose `services` list leaves the name out is refused
   * at plan time rather than deployed with the edge quietly dropped.
   *
   * Most ordering is derived instead — a client after the identity provider it
   * asks, a certificate reader after the proxy whose store the copy comes out
   * of — and this is for the edges nothing implies. It reaches systemd as an
   * `After=` and Pulumi as a dependency on the real resource, so the first
   * deploy and every boot after it start them in the same order.
   *
   * Deliberately not "a service with a vhost depends on the proxy": a route file
   * needs nothing running to be written, and the rule would be a cycle here,
   * since the resolver has a vhost and the proxy needs the resolver.
   */
  dependsOn?: readonly string[];
  /**
   * Certificate files this service reads out of the proxy's store. The units
   * that fill them follow from this, and so does the `Wants=`/`After=` pair that
   * makes a start attempt one first — a one-shot nothing pulls in never runs,
   * and ordering alone would be a start with no certificate.
   */
  certificates?: CertificateFiles;
  /**
   * Non-secret environment, in whatever names the service itself reads.
   *
   * In a *committed* entry it names no installation — a value that does is
   * composed in `setup` from the object handed to it, which is what keeps the
   * example catalog adoptable and what `tests/catalog.test.ts` enforces. A local
   * entry is one installation's configuration already, so what only that service
   * needs is stated here rather than routed through a field on `Installation`.
   */
  env?: Record<string, string>;
  cmd?: string;
  /**
   * A systemd `OnCalendar=` expression, for an entry that runs to completion on a
   * clock instead of staying up.
   *
   * Stating it is the whole of what makes an entry a scheduled one: it is a
   * `ServiceSpec` and not a kind of its own, so everything already derived from an
   * entry still is — the digest pin for a rolling tag, the cap and the slice, the
   * sealed environment, the mounts, the egress, the backup set, the gaps and the
   * ordering. What it turns off is the four things that only mean something for a
   * listener: `Restart=`, the health check, the `[Install]` section, and the
   * published port.
   *
   * A failed run reaches a phone without anyone looking, and that follows from the
   * one-shot rather than from anything added here: a container that exits non-zero
   * leaves the unit `failed`, which is exactly what `keel-alert.service` lists —
   * while a run that worked leaves it inactive, which is its success.
   *
   * `port` stays required and such an entry states a nominal one. Making it
   * optional would hand every other reader of it a `number | undefined` for the
   * sake of the one kind of entry that binds nothing. What the number does not do
   * is own a host port: nothing listens on it, so the collision rule does not
   * claim it — reserving a number for a listener that does not exist would report
   * the first real user of it as a clash.
   */
  schedule?: string;
  /**
   * Where a scheduled entry's standard output is captured, as an absolute path on
   * the host. It becomes `StandardOutput=file:` on the unit, and the directory is
   * created before the run.
   *
   * This is the sink a third-party image can always use: a job that prints its
   * result needs no egress to hand it over, no endpoint to POST to and no
   * credential to do it with, and whatever wants the result mounts the path
   * read-only. Stderr is deliberately pinned to the journal beside it —
   * systemd's default for `StandardError=` is to duplicate `StandardOutput=`, so
   * without that the run's own logging would be interleaved into the document.
   *
   * The honest limit: `file:` truncates at start and appends as the job runs, so
   * a run that dies midway leaves a partial document where a whole one was, and a
   * reader has no way to tell the two apart. Output that must never be read
   * half-written is a job that writes its own temporary file and renames it —
   * which is the application's business and not a thing a unit can express.
   *
   * Only meaningful with a `schedule`: a service that stays up would be writing
   * into a file truncated at every restart, so `deploymentGaps` refuses the
   * combination.
   */
  stdoutFile?: string;
  /**
   * A command inside the container that succeeds once the service answers.
   *
   * Setting it holds the start job open until it passes. Without it
   * `--sdnotify=conmon` reports success as soon as the container is running, so
   * a deploy moves on — or a test asserts — while the service is still coming up.
   *
   * It has to be spelled out here: podman does not adopt the image's own
   * HEALTHCHECK for this, and asking for the wait without a command fails the
   * unit outright with `sdnotify policy "healthy" requires a healthcheck`.
   *
   * **A bare string is run by the container's `/bin/sh`**, which an image built
   * from scratch does not have. Podman reports that as an ordinary failing check
   * — exit 1, no output — so the service never becomes healthy and the start job
   * fails at `TimeoutStartSec` with nothing in the journal pointing at the
   * missing shell. Prefix the value with `CMD ` for the exec form, which needs no
   * shell and is what a distroless image wants.
   */
  healthCmd?: string;
  /** Include `/var/lib/<name>` in the restic snapshot set. */
  backup?: boolean;
  /**
   * Paths inside the backup path that the snapshot leaves out — derived state a
   * restore regenerates. Every entry is restic `--exclude` pattern, and listing
   * one for a service with no `backup` is a contradiction a test refuses.
   */
  backupExclude?: readonly string[];
  /**
   * The capabilities this entry is, for the entries that need one. Each is
   * claimed by at most one deployed service, and what claims it is the whole of
   * how the others find it: a route asks the proxy role where it lands, a client
   * asks the identity role for an issuer, a gated route asks the gate role where
   * to send an unauthenticated visitor.
   */
  proxy?: ProxyRole;
  identity?: IdentityRole;
  gate?: GateRole;
  alerts?: AlertRole;
  metrics?: MetricsRole;
  /**
   * An account on the metrics hub, created by the deploy rather than by a
   * person: the password is generated inside the resource that seals it, so it
   * exists in no vault and in no state file. Declaring it is what creates the
   * account, the blob it is sealed into and the second `EnvironmentFile=` the
   * container reads it from.
   */
  metricsAccount?: MetricsAccount;
  /**
   * The first account on this service, claimed by the deploy. Declaring it is
   * what creates the resource that posts the setup call, and the token that call
   * answers with is what every later call against this service authenticates as.
   *
   * It is the one credential in this repository that lands in Pulumi state: the
   * server mints it and this repository makes no vault writes, so there is
   * nowhere else to put it. See `src/infra/providers/netbirdAccount.ts`.
   */
  bootstrapAccount?: BootstrapAccount;
  /**
   * The half of this service's configuration that names the installation. It is
   * declared on the entry so that a service is one entry: nothing outside the
   * catalog maps a service to what it needs. Its context carries the entry
   * itself and the resolved roles, which is how the gate finds the issuer and
   * the proxy finds the gate — by capability, never by name.
   */
  setup?: (context: SetupContext) => ServiceSetup;
};

/** The role fields, which are the keys `roles()` resolves. */
type RoleKey = "proxy" | "identity" | "gate" | "alerts" | "metrics";

/**
 * The entry claiming one role, or undefined when nothing being deployed does.
 *
 * Two claimants is a configuration error rather than a precedence question:
 * which of two proxies a route is written for, or which of two identity
 * providers a client is registered with, has no answer this could pick that
 * would not be a guess. So it names both and stops.
 */
function claimant<K extends RoleKey>(
  specs: readonly ServiceSpec[],
  role: K,
): Claimed<NonNullable<ServiceSpec[K]>> | undefined {
  const claiming = specs.filter((spec) => spec[role] !== undefined);
  if (claiming.length > 1) {
    throw new Error(
      `${claiming.map((spec) => spec.name).join(" and ")} both claim the ${role} role — ` +
        "exactly one entry may be it",
    );
  }
  const [spec] = claiming;
  return spec === undefined ? undefined : { spec, role: spec[role]! };
}

/**
 * Which entry is the proxy, the identity provider, the gate, the alert sink and
 * the metrics hub, by presence.
 */
export function roles(specs: readonly ServiceSpec[]): Roles {
  return {
    proxy: claimant(specs, "proxy"),
    identity: claimant(specs, "identity"),
    gate: claimant(specs, "gate"),
    alerts: claimant(specs, "alerts"),
    metrics: claimant(specs, "metrics"),
  };
}

/** Those roles beside the set they came from, which is what a setup is handed. */
export function catalogOf(
  specs: readonly ServiceSpec[],
  remotes: readonly RemoteSpec[] = [],
): Catalog {
  return { ...roles(specs), services: specs, remotes };
}

/**
 * Everything with a name in the zone: every service with a vhost, plus every
 * remote — sorted by name, which is what makes reordering either list not a
 * restart of the resolver's hosts file.
 */
export function vhosts(catalog: Catalog): readonly { name: string; subdomain: string }[] {
  return [
    ...catalog.services
      .filter((spec) => subdomainOf(spec) !== null)
      .map((spec) => ({ name: spec.name, subdomain: subdomainOf(spec)! })),
    ...catalog.remotes.map((remote) => ({ name: remote.name, subdomain: remote.subdomain })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Public DNS records: `vhosts()` filtered to the entries that opted in with
 * `publicDns: true`, in the same order — a Cloudflare record and a Pi-hole line
 * are the same subdomain, arrived at the same way, from two different readings
 * of one list.
 */
export function publicRecords(
  catalog: Catalog,
  network: Network,
): readonly { name: string; fqdn: string; content: string }[] {
  const opted = new Set([
    ...catalog.services.filter((spec) => spec.publicDns === true).map((spec) => spec.name),
    ...catalog.remotes.filter((remote) => remote.publicDns === true).map((remote) => remote.name),
  ]);
  return vhosts(catalog)
    .filter((vhost) => opted.has(vhost.name))
    .map((vhost) => ({
      name: vhost.name,
      fqdn: `${vhost.subdomain}.${network.domain}`,
      content: network.lanAddress,
    }));
}

/**
 * What has to be running before one entry is started, by name.
 *
 * Three derived edges and whatever the entry wrote down. A service that runs an
 * OIDC client of its own is started after the identity provider it asks, because
 * the discovery document is fetched at startup and a client that cannot reach its
 * issuer exits. A service that reads a certificate out of the proxy's store is
 * started after the proxy, because the store is the proxy's file and an empty one
 * is what a reader finds before the proxy has issued anything. A service with an
 * account on the metrics hub is started after the hub, because the account is
 * created by calling it and a hub that is not answering has nothing to create.
 *
 * All three are read off declarations the entry already makes, so none is a name
 * matched here. `dependsOn` is the rest: an edge nothing implies, stated once.
 */
export function dependencyNames(spec: ServiceSpec, roles: Roles): readonly string[] {
  const derived = [
    ...(spec.auth === "oidc" && roles.identity !== undefined ? [roles.identity.spec.name] : []),
    ...(spec.certificates !== undefined && roles.proxy !== undefined
      ? [roles.proxy.spec.name]
      : []),
    ...(spec.metricsAccount !== undefined && roles.metrics !== undefined
      ? [roles.metrics.spec.name]
      : []),
  ];
  return [...new Set([...derived, ...(spec.dependsOn ?? [])])].filter((name) => name !== spec.name);
}

/**
 * The deployed set in an order that puts every service after what it needs
 * running, and the three refusals that make such an order exist at all.
 *
 * Pure, and separate from `deploymentGaps` because it has a value to return: the
 * deploy layer walks this order and hands each service the resources of the ones
 * ahead of it, so the Pulumi dependency is the real resource rather than a hope
 * about scheduling.
 *
 * `whole` is the entire catalog, and it is what separates the two ways a
 * dependency can be missing. A name nothing in the catalog claims is a typo. A
 * name the catalog has but this host's `services` list leaves out is a deployment
 * that would start a service against something that is not there — reported as
 * the selection question it is, rather than as a misspelling.
 */
export function orderServices(
  catalog: Catalog,
  whole: readonly ServiceSpec[] = catalog.services,
): readonly ServiceSpec[] {
  const deployed = new Map(catalog.services.map((spec) => [spec.name, spec]));
  const known = new Set(whole.map((spec) => spec.name));

  const ordered: ServiceSpec[] = [];
  const done = new Set<string>();
  // The names on the current descent, in order, so a cycle can be reported as
  // the loop it is rather than as the one edge that happened to close it.
  const path: string[] = [];
  const onPath = new Set<string>();

  const visit = (spec: ServiceSpec): void => {
    if (done.has(spec.name)) return;
    if (onPath.has(spec.name)) {
      const loop = [...path.slice(path.indexOf(spec.name)), spec.name];
      throw new Error(
        `these services depend on each other in a cycle: ${loop.join(" -> ")} — there is no ` +
          "order that starts each of them after the other",
      );
    }
    path.push(spec.name);
    onPath.add(spec.name);
    for (const name of dependencyNames(spec, catalog)) {
      const next = deployed.get(name);
      if (next === undefined) {
        throw new Error(
          known.has(name)
            ? `${spec.name} depends on ${name}, which this host's services list leaves out — a ` +
                "dependency is ordering and never selection, so either the host lists " +
                `${name} too or ${spec.name} does not belong on this host`
            : `${spec.name} depends on '${name}', which no catalog entry is called`,
        );
      }
      visit(next);
    }
    onPath.delete(spec.name);
    path.pop();
    done.add(spec.name);
    ordered.push(spec);
  };

  for (const spec of catalog.services) visit(spec);
  return ordered;
}

/**
 * Run one entry's `setup` with its context composed: itself, the house, the
 * resolved roles, and origins built from the zone it is being deployed into. One
 * definition, so the deploy layer and the tests drive an entry the same way.
 */
export function runSetup(
  spec: ServiceSpec,
  installation: Installation,
  catalog: Catalog,
): ServiceSetup | undefined {
  return spec.setup?.({
    self: spec,
    installation,
    catalog,
    origin: (other = spec) => serviceOrigin(other, installation.network.domain),
  });
}

/**
 * The one-shot that fills a service's certificate directory, named after the
 * service that reads it — or null for one that declares no certificates.
 *
 * The quadlet renderer and the deploy layer both ask this, so the unit a
 * container waits for and the unit that gets written cannot end up different
 * names.
 */
export function certSyncName(spec: ServiceSpec): string | null {
  return spec.certificates === undefined ? null : `${spec.name}-cert-sync`;
}

/**
 * What a deployed set names and would not find.
 *
 * Every error here is a failure that happens where nobody is looking: a route
 * naming a middleware the proxy has no definition for is a router it refuses to
 * build, so the vhost fails closed and silently — the worst shape available. A
 * gap in the other direction, a vhost with no proxy to route it, costs a warning
 * instead: nothing is written, the service answers on loopback, and the name
 * simply does not resolve to anything yet.
 *
 * Pure, so each precondition is a test rather than something a deploy discovers.
 */
export function deploymentGaps(catalog: Catalog): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const named = (entries: readonly { name: string }[]): string =>
    entries.map((entry) => entry.name).join(", ");

  const gated = [
    ...catalog.services.filter((spec) => spec.auth === "edge"),
    ...catalog.remotes.filter((remote) => remote.auth === "edge"),
  ];
  if (catalog.gate === undefined && gated.length > 0) {
    errors.push(
      "no deployed entry claims the gate role, and these route through the edge gate: " +
        `${named(gated)} — each route would name a middleware nothing defines, and a router ` +
        "Traefik refuses to build fails closed silently",
    );
  }

  const oidcRemotes = catalog.remotes.filter((remote) => remote.auth === "oidc");
  if (oidcRemotes.length > 0) {
    errors.push(
      `these remotes declare auth: "oidc": ${named(oidcRemotes)} — a remote runs its own flow ` +
        "or none, because the board has no client of its own to hand it",
    );
  }

  const remoteNameClashes = catalog.remotes.filter((remote) =>
    catalog.services.some((spec) => spec.name === remote.name),
  );
  if (remoteNameClashes.length > 0) {
    errors.push(
      `these remotes share a name with a deployed service: ${named(remoteNameClashes)} — a ` +
        "router and a service are one Traefik namespace by name, so the remote's route file " +
        "would overwrite the service's",
    );
  }

  const subdomainOwners = new Map<string, string>();
  for (const spec of catalog.services) {
    const subdomain = subdomainOf(spec);
    if (subdomain !== null) subdomainOwners.set(subdomain, spec.name);
  }
  const subdomainClashes: string[] = [];
  for (const remote of catalog.remotes) {
    const owner = subdomainOwners.get(remote.subdomain);
    if (owner !== undefined) {
      subdomainClashes.push(`${remote.name} and ${owner} both answer '${remote.subdomain}'`);
    } else {
      subdomainOwners.set(remote.subdomain, remote.name);
    }
  }
  if (subdomainClashes.length > 0) {
    errors.push(`two entries answer one subdomain: ${subdomainClashes.join("; ")}`);
  }

  // Several routers on one vhost divide that vhost's paths, and every way of
  // writing the division wrong is a request answered by the wrong upstream with
  // nothing in any log about it.
  for (const spec of catalog.services) {
    if (spec.routers === undefined) continue;
    if (subdomainOf(spec) === null) {
      errors.push(
        `${spec.name} declares routers and no vhost — a router divides one vhost's paths, so ` +
          "give the entry a subdomain or drop the routers",
      );
    }
    const names = new Set<string>();
    const rules = new Set<string>();
    for (const router of spec.routers) {
      if (names.has(router.name)) {
        errors.push(
          `${spec.name} declares two routers called '${router.name}' — one name is one router ` +
            "and one load balancer, so the second would replace the first; name them apart",
        );
      }
      names.add(router.name);
      if (router.match?.includes("Host(") === true) {
        errors.push(
          `${spec.name}'s '${router.name}' router matches on Host( — the host is the entry's ` +
            "vhost and the allowlist is keyed to it, so a router spelling its own is a way past " +
            "it; match on the path and let the vhost say the host",
        );
      }
      if (router.match === undefined) continue;
      const rule = `${router.priority} ${router.match}`;
      if (rules.has(rule)) {
        errors.push(
          `${spec.name} declares two routers at priority ${router.priority} matching ` +
            `'${router.match}' — Traefik picks between equal rules arbitrarily, so say which ` +
            "one wins with a priority of its own",
        );
      }
      rules.add(rule);
    }
    const catchAll = spec.routers.filter((router) => router.match === undefined);
    if (catchAll.length > 1) {
      errors.push(
        `${spec.name} declares ${catchAll.length} routers with no match — exactly one takes what ` +
          "the others leave, so give the rest a match of their own",
      );
    }
  }

  // A scheduled entry is a job that exits, and both of these are ways of asking
  // its port a question. Neither fails where anybody would see it: a health check
  // that cannot pass fails the unit at its start timeout, so the run that worked
  // is reported as a broken schedule — and a vhost is a route, a hosts-file line
  // and a status check all pointed at a port nothing binds.
  const scheduled = catalog.services.filter((spec) => spec.schedule !== undefined);
  const probed = scheduled.filter((spec) => spec.healthCmd !== undefined);
  if (probed.length > 0) {
    errors.push(
      `these run on a schedule and declare a health check: ${named(probed)} — a check is a ` +
        "question about a listener and a job that runs to completion has none, so " +
        "`Notify=healthy` would hold the start job open until it timed out and every " +
        "successful run would be recorded as a failure",
    );
  }
  const answering = scheduled.filter((spec) => subdomainOf(spec) !== null);
  if (answering.length > 0) {
    errors.push(
      `these run on a schedule and answer a vhost: ${named(answering)} — the route, the LAN ` +
        "name and the status check would all point at a port nothing binds, so a scheduled " +
        "entry states `subdomain: null`",
    );
  }
  const capturing = catalog.services.filter(
    (spec) => spec.stdoutFile !== undefined && spec.schedule === undefined,
  );
  if (capturing.length > 0) {
    errors.push(
      `these capture their output to a file and run on no schedule: ${named(capturing)} — the ` +
        "file is truncated at every start, so a service that stays up would leave a reader a " +
        "document that empties whenever the unit restarts",
    );
  }
  const relative = catalog.services.filter(
    (spec) => spec.stdoutFile !== undefined && !spec.stdoutFile.startsWith("/"),
  );
  if (relative.length > 0) {
    errors.push(
      `these capture their output to a path that is not absolute: ${named(relative)} — the path ` +
        "is the host's and systemd resolves it against the unit's working directory, so a " +
        "relative one lands somewhere nothing mounts",
    );
  }

  const clients = catalog.services.filter((spec) => spec.auth === "oidc");
  if (catalog.identity === undefined && clients.length > 0) {
    errors.push(
      "no deployed entry claims the identity role, and these run an OIDC client of their " +
        `own: ${named(clients)} — there is no issuer for them to ask`,
    );
  }

  // A client's own half of the flow — discovery, the token exchange, the JWKS
  // fetch — is a request the service makes to the issuer's vhost, and every
  // route's allowlist plus the packet filter admit the LAN and the mesh only.
  // The host's address is in both sets; a bridge address is in neither, and the
  // internal bridge has no route off the host at all. So a client anywhere but
  // the host's own stack is a login that fails at its first use, which is why
  // this is refused at the deploy rather than discovered on the device.
  const bridged = clients.filter((spec) => (spec.egress ?? "internal") !== "host");
  if (bridged.length > 0) {
    errors.push(
      `these run an OIDC client of their own from a bridge: ${named(bridged)} — the back ` +
        "channel to the issuer leaves from an address no route's allowlist admits, so the " +
        'login fails at first use. `egress: "host"` is what the gate does and why',
    );
  }

  const accounts = catalog.services.filter((spec) => spec.metricsAccount !== undefined);
  if (catalog.metrics === undefined && accounts.length > 0) {
    errors.push(
      "no deployed entry claims the metrics role, and these are deployed with an account on " +
        `it: ${named(accounts)} — there is no hub for the deploy to create one on, and the ` +
        "env file each of them reads its login out of would never be written",
    );
  }

  // A connector is a client of the identity provider, registered on the other
  // side: the issuer it is given comes from whichever entry claims the identity
  // role, so a deployment with none has no URL to hand it and the federation
  // would be registered pointing at nothing.
  const federating = catalog.services.filter(
    (spec) => spec.bootstrapAccount?.connector !== undefined,
  );
  if (catalog.identity === undefined && federating.length > 0) {
    errors.push(
      "no deployed entry claims the identity role, and these federate their own broker to " +
        `it: ${named(federating)} — there is no issuer to register the connector against`,
    );
  }

  const readers = catalog.services.filter((spec) => spec.certificates !== undefined);
  if (readers.length > 0 && catalog.proxy?.role.certificateStore === undefined) {
    errors.push(
      (catalog.proxy === undefined
        ? "no deployed entry claims the proxy role"
        : `${catalog.proxy.spec.name} claims the proxy role and keeps no certificate store`) +
        `, and these read a certificate out of one: ${named(readers)}`,
    );
  }

  if (catalog.proxy === undefined) {
    const stranded = catalog.services.filter((spec) => subdomainOf(spec) !== null);
    if (stranded.length > 0) {
      warnings.push(`no deployed proxy routes to these vhosts: ${named(stranded)}`);
    }
  }

  return { errors, warnings };
}

/**
 * The one directory a sealed blob is opened in. `keel-secrets.service` decrypts
 * `*.age` here and nowhere else, so this is what makes a path a secret's rather
 * than a convention anybody has to remember.
 */
export const SECRETS_DIR = "/etc/secrets";

/** Where a service's decrypted env file lands, or null when it has no secrets. */
export function secretsPath(spec: ServiceSpec): string | null {
  return spec.secretEnv === undefined ? null : `${SECRETS_DIR}/${spec.name}.env`;
}

/**
 * Whether a generated file's path is one the boot-time decrypt will open — a
 * plain file directly under `SECRETS_DIR`.
 *
 * A blob written anywhere else is written correctly, never decrypted, and
 * discovered as a container that will not start with its configuration missing.
 * So the deploy refuses the path rather than the device reporting the symptom.
 */
export function isSecretsPath(path: string): boolean {
  const rest = path.startsWith(`${SECRETS_DIR}/`) ? path.slice(SECRETS_DIR.length + 1) : "";
  return rest.length > 0 && !rest.includes("/");
}

/**
 * A generated file's body with every value it will be handed stood in for.
 *
 * What `yarn spec` prints and what the golden pins: the shape of the file is
 * reviewable — every line of it except the key material — while the values
 * themselves do not exist until a deploy draws them, and never appear in a
 * snapshot, a terminal or this repository.
 */
export function secretFileShape(file: ServiceSecretFile, placeholder = "<generated>"): string {
  return file.content(
    Object.fromEntries(Object.keys(file.generate).map((name) => [name, placeholder])),
  );
}

/**
 * Where the metrics account's decrypted env file lands, or null for a service
 * that has no account on the hub.
 *
 * A file of its own rather than lines in the one above: the vault-read half and
 * the generated half rotate for different reasons and are written by different
 * resources, and `keel-secrets.service` decrypts whatever `*.age` it finds, so a
 * second blob costs nothing on the device.
 */
export function metricsSecretsPath(spec: ServiceSpec): string | null {
  return spec.metricsAccount === undefined ? null : `${SECRETS_DIR}/${spec.name}.metrics.env`;
}

/**
 * The address an account the deploy creates is made under: the service's own
 * name in the fleet's zone.
 *
 * Derived rather than declared, because it identifies a machine account and
 * nobody reads mail at it — and a name typed into a catalog twice is a name that
 * can disagree with itself, which on the far side is a second account rather
 * than an error. Read by both the account a service is given on the metrics hub
 * and the first account the deploy claims on a service that boots without one.
 */
export function deployedAccountEmail(spec: ServiceSpec, domain: string): string {
  return `${spec.name}@${domain}`;
}

/**
 * `/var/lib/<name>`, when the service has state worth restoring, else null.
 *
 * One definition, read by both layers: the `Service` component publishes it, and
 * the backup renderer derives the whole snapshot set from it — so adding a
 * service to the backup is setting `backup: true` and nothing else.
 */
export function backupPath(spec: ServiceSpec): string | null {
  return spec.backup === true ? `/var/lib/${spec.name}` : null;
}

/** The vhost a service answers on, or null for one with no web surface. */
export function subdomainOf(spec: ServiceSpec): string | null {
  if (spec.subdomain === null) return null;
  return spec.subdomain ?? spec.name;
}

/**
 * `https://<subdomain>.<domain>` — the public URL of a service's own vhost.
 *
 * Every absolute URL an entry composes is built from this rather than restated,
 * so moving a vhost moves the issuer, the redirect, the invitation link and the
 * route together.
 */
export function serviceOrigin(spec: ServiceSpec, domain: string): string {
  const subdomain = subdomainOf(spec);
  if (subdomain === null) throw new Error(`${spec.name} has no vhost to build a URL from`);
  return `https://${subdomain}.${domain}`;
}

/**
 * A service's secret variables resolved to the item and field each one reads.
 * The bare-string form means the service's own item, which is what almost every
 * entry says, so the pair is spelled out only where it is genuinely elsewhere.
 */
export function secretFields(spec: ServiceSpec): Record<string, { item: string; field: string }> {
  return resolveSecretRefs(spec.vaultItem ?? spec.name, spec.secretEnv);
}

/**
 * The same resolution for anything that reads the vault without being a service
 * — the backup's repository password and share login are one item's field and
 * two of another's.
 */
export function resolveSecretRefs(
  own: string,
  refs: Record<string, SecretRef> = {},
): Record<string, { item: string; field: string }> {
  return Object.fromEntries(
    Object.entries(refs).map(([name, ref]) => [
      name,
      typeof ref === "string" ? { item: own, field: ref } : ref,
    ]),
  );
}
