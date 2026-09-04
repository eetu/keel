/**
 * The example service catalog, and the composition every consumer reads.
 *
 * One entry is the whole declaration of a service: the `Service` component in
 * `src/infra/` turns it into a quadlet, a systemd unit, a memory drop-in, a
 * Traefik route, a DNS record, an OIDC client, a network attachment and a backup
 * path. Nothing about a service is stated twice, and nothing about one lives
 * anywhere else.
 *
 * What is committed here is what keel *is*: a resolver with ad blocking, a proxy
 * holding a wildcard certificate, an identity provider, the gate in front of
 * every route, and a password manager — the reason to adopt this at all, and a
 * set anybody would want. One installation's own services are the gitignored
 * `services.local.ts`, whose twin `services.local.example.ts` is what a fresh
 * clone copies into place. `SERVICES` is the two appended, and nothing downstream
 * can tell them apart: same type, same renderers, same tests.
 *
 * What one entry *is* — the fields, and the pure readings of them — is
 * `spec.ts`. The strings that belong to a particular product rather than to a
 * particular service are `src/adapters/`: an issuer's shape, a gate's endpoints,
 * a proxy's configuration files. An entry composes those; it spells none of them.
 *
 * Where a service needs a value that belongs to the house rather than to the
 * fleet — a zone, a mail relay, a bridge address — its entry says so with a
 * `setup`, which is handed the single `Installation` object from the gitignored
 * `installation.ts`. So an entry stays generic wherever it can: what is true of the
 * service is here, what is true of one house arrives through `setup`. There is no
 * registry to add a name to and no dispatch to extend.
 *
 * Where one service needs another, the entry names a *role* and never a service:
 * the proxy that routes to everything, the identity provider clients trust, the
 * gate a route is sent through. A `setup` is handed those resolved, so no entry
 * looks another up and no entry looks itself up.
 *
 * Every entry here is Pulumi-deployed — a quadlet `pulumi up` writes to a running
 * host, not image content. The image itself carries only native unbound; the
 * other core services (pihole, traefik, kanidm, oauth2-proxy) are entries in this
 * same catalog, deployed like any other service once a host is reachable.
 */

import { KANIDM_IDENTITY } from "../adapters/kanidm";
import {
  gateRole,
  OAUTH2_TEMPLATES_DIR,
  SIGN_IN_TEMPLATE_PATH,
  signInTemplate,
} from "../adapters/oauth2Proxy";
import {
  TRAEFIK_DIR,
  TRAEFIK_HEALTH_CMD,
  TRAEFIK_MIDDLEWARES_PATH,
  TRAEFIK_PROXY,
  TRAEFIK_STATIC_PATH,
  traefikMiddlewares,
  type TraefikOptions,
  traefikStatic,
} from "../adapters/traefik";
import { UNBOUND } from "./keel";
import { LOCAL_REMOTES, LOCAL_SERVICES } from "./services.local";
import { type RemoteSpec, type ServiceSpec, vhosts } from "./spec";

// Each of these is read twice — once as the port the entry declares, once
// inside the address that entry's server is told to bind — so it is named
// rather than written out twice and left to be kept in step by hand.
const KANIDM_PORT = 8443;
const OAUTH2_PROXY_PORT = 4180;
const VAULTWARDEN_PORT = 8085;

/**
 * chain.pem and key.pem, kept in step with the proxy's wildcard by the sync the
 * `certificates` declaration below creates. The server is told to read them here
 * and the sync writes them here, from one definition: a copy on either side
 * would be a certificate nobody finds.
 */
const KANIDM_CERT_DIR = "/etc/kanidm/certs";

/**
 * The host side of Pi-hole's own mount below, reused so the hosts file its
 * `setup` writes for dnsmasq's `hostsdir` cannot drift from where the volume
 * actually lands.
 */
const PIHOLE_DATA_DIR = "/var/lib/pihole";

/**
 * The gate's name, which is also the OAuth2 client Kanidm has registered — one
 * name, read as both, because a client id that drifted from the service holding
 * the secret is a login that fails at the token exchange.
 */
const SESSION_GATE = "oauth2-proxy";

/** The gate's own vocabulary, at the port its entry declares. */
const GATE = gateRole(OAUTH2_PROXY_PORT);

/** The five services keel ships as itself. Committed, and nobody's in particular. */
export const EXAMPLE_SERVICES: readonly ServiceSpec[] = [
  {
    name: "traefik",
    description: "TLS terminator and the only listener facing the LAN",
    // v3.7.12
    image:
      "docker.io/library/traefik@sha256:9c2a54d87f76f5c2f5f2682c68394af92fb12c0a2686798d6462a3f84bd78eaf",
    // What it binds on the host. Every other service's port is a loopback
    // upstream behind this one.
    port: 443,
    memory: { max: 128, measuredMb: 83, tier: "core" },
    // It terminates 443 for the whole LAN, and the allowlist middleware matches
    // on the client's address — which a bridge would rewrite to the gateway's.
    egress: "host",
    // Nothing routes to Traefik itself: the dashboard is not exposed, so there
    // is no vhost and no route file for it.
    subdomain: null,
    // Nothing to gate: with no vhost there is no route, and the packet filter is
    // what admits :443 in the first place.
    auth: "open",
    // 80 is deliberately absent. The wildcard certificate comes from a DNS-01
    // challenge, so there is no HTTP challenge to answer and no redirect to
    // serve — which is the reason Traefik was chosen over the alternatives.
    ingress: { lanTcp: [443], meshTcp: [443] },
    mounts: [
      // Static config, middlewares and the route files, all written by Pulumi.
      `${TRAEFIK_DIR}:${TRAEFIK_DIR}:ro,Z`,
      // acme.json. Backed up because a restore that has to re-issue every
      // certificate walks straight into Let's Encrypt's rate limit.
      "/var/lib/traefik:/var/lib/traefik:Z",
    ],
    // The DNS-01 challenge writes a TXT record through Cloudflare's API.
    // The token is the `cloudflare` login item's password field — where the
    // vault has always kept it, alongside its `zone_id`.
    secretEnv: { CF_DNS_API_TOKEN: "password" },
    vaultItem: "cloudflare",
    backup: true,
    // The DNS-01 challenge writes a TXT record through the registrar's API, so
    // the proxy's first act is a name lookup — and the resolver is what this host
    // is configured to prefer for one. Ordering and not a precondition: the
    // image's `/etc/resolv.conf` is static, with public fallbacks after
    // 127.0.0.1 and `timeout:1 attempts:2`, precisely so a query works before
    // Pi-hole exists (see `src/render/network.ts`). The API therefore resolves
    // either way; the edge only keeps the first certificate order off the
    // fallback path, which costs a timeout per query and skips the filtering.
    // The reverse is deliberately not a rule: the resolver has a vhost, and "a
    // vhost depends on the proxy" would close the loop. A route file needs
    // nothing running to be written.
    dependsOn: ["pihole"],
    // "Answering", which is what the services ordered after it are waiting for.
    // Not "holding a certificate": this succeeds while the ACME order is still
    // in flight, and the wait for a certificate belongs to whoever reads one out
    // of the store.
    healthCmd: TRAEFIK_HEALTH_CMD,
    // It is the proxy: every route file, the certificate store Kanidm's own
    // certificate is extracted from, and the unit other things order against.
    proxy: TRAEFIK_PROXY,
    setup: ({ installation: { network, mesh }, catalog }) => {
      const options: TraefikOptions = {
        domain: network.domain,
        // A mesh peer is treated like a LAN client, which is what makes reaching
        // a service from outside the house a matter of being on the mesh.
        allowedRanges: [network.lanCidr, mesh.v4, mesh.v6],
        // Resolved by role: where the forward-auth query goes is the gate's fact
        // about itself, not something the proxy gets to have an opinion on.
        gate: catalog.gate?.role,
      };
      return {
        files: [
          // Read once at start, so a change restarts the proxy.
          { name: "static", path: TRAEFIK_STATIC_PATH, content: traefikStatic(options) },
          // Watched, so the definitions the routes reference arrive live.
          {
            name: "middlewares",
            path: TRAEFIK_MIDDLEWARES_PATH,
            content: traefikMiddlewares(options),
            restarts: false,
          },
        ],
      };
    },
  },
  {
    name: "kanidm",
    description: "Identity provider — the OIDC issuer everything else trusts",
    // 1.11.1
    image:
      "docker.io/kanidm/server@sha256:7c3d7ed868e91f78c24a7fb9c548876563b375a4203021b730d58369b97ad154",
    port: KANIDM_PORT,
    memory: { max: 64, measuredMb: 31, tier: "core" },
    subdomain: "idm",
    // The login page is a name a browser types, so it resolves the same way from
    // the LAN and from the mesh. The record points at the LAN address; reaching
    // it from outside the house is still a matter of being on the mesh, because
    // the route carries the allowlist.
    publicDns: true,
    // It *is* the identity provider: its own login page is the thing every other
    // service's gate redirects to, and putting a gate in front of it would be a
    // loop with nothing at the end of it.
    auth: "open",
    // Kanidm has no plaintext listener: it terminates TLS itself, with its own
    // certificate, on loopback.
    tlsUpstream: true,
    mounts: [
      "/var/lib/kanidm:/data:Z",
      // chain.pem and key.pem, kept in step with Traefik's wildcard by the cert
      // sync. Read-only: the sync writes them from the host.
      "/etc/kanidm:/etc/kanidm:ro,Z",
    ],
    // Configured entirely through the environment — Kanidm reads every one of
    // these before it would read a server.toml, so there is no file to keep in
    // step with the catalog.
    env: {
      // The container's own namespace, not the host's: podman publishes this to
      // 127.0.0.1 on the outside, and a process bound to loopback *inside* the
      // namespace would not be reachable through that.
      KANIDM_BINDADDRESS: `0.0.0.0:${KANIDM_PORT}`,
      KANIDM_DB_PATH: "/data/kanidm.db",
      KANIDM_TLS_CHAIN: `${KANIDM_CERT_DIR}/chain.pem`,
      KANIDM_TLS_KEY: `${KANIDM_CERT_DIR}/key.pem`,
    },
    // Kanidm terminates TLS itself and exits when its certificate is missing, so
    // it reads a copy of the proxy's wildcard. Declaring the directory is what
    // creates the sync that fills it and makes every start attempt one first: a
    // failed attempt is not fatal, because the unit is wanted rather than
    // required and the files already on disk are what the last sync left.
    certificates: { dir: KANIDM_CERT_DIR },
    // "Serving TLS", which is what the gate's own start needs of it: the gate
    // fetches this issuer's discovery document before it will run. The exec
    // form because the image is built from scratch and has no shell for podman
    // to run a bare command line through; the check reads the same environment
    // the quadlet sets, so it asks about this server rather than a default.
    healthCmd: "CMD /sbin/kanidmd scripting healthcheck",
    backup: true,
    // It is the identity provider: the issuer every OIDC client in the fleet
    // asks, and the account a client registration authenticates as.
    identity: KANIDM_IDENTITY,
    // `KANIDM_ORIGIN` is what the server signs its tokens with and checks
    // redirects against, so it is the public URL of its own vhost and not the
    // loopback address Traefik dials it on.
    setup: ({ origin }) => {
      const own = origin();
      return { env: { KANIDM_ORIGIN: own, KANIDM_DOMAIN: own.replace("https://", "") } };
    },
  },
  {
    name: SESSION_GATE,
    description: "Forward-auth gate in front of every SSO route",
    // v7.15.4
    image:
      "quay.io/oauth2-proxy/oauth2-proxy@sha256:b1b2021fe8f4004573e8d690dec6c7bb29cc44364572cf8510a05bf3a0ae2ded",
    port: OAUTH2_PROXY_PORT,
    memory: { max: 48, measuredMb: 18, tier: "core" },
    // Traefik calls it as a middleware, but the browser is sent back here after
    // the login: the callback is the redirect URI registered with the OIDC
    // client, so the vhost is part of the flow rather than a dashboard. The
    // route carries `internal-only` like every other one.
    subdomain: "auth",
    publicDns: true,
    // It is the gate. Its own sign-in page and callback have to be reachable by
    // a browser that has not authenticated yet — that is what they are for.
    auth: "open",
    // It authenticates against the identity provider through that provider's own
    // vhost, so its requests have to arrive from an address the allowlist
    // admits. The host's LAN address does; a bridge address does not, and the
    // internal network has no route off the host at all.
    egress: "host",
    // The sign-in template, written by Pulumi because it names the zone. Nothing
    // in the container has a reason to write here.
    mounts: ["/etc/oauth2-proxy:/etc/oauth2-proxy:ro,Z"],
    // Every functional setting, in the environment rather than a config file —
    // one mechanism, and no file to keep in step with the catalog.
    env: {
      // Host networking, so this is the host's loopback: Traefik is the only
      // listener that faces the LAN, and the forward-auth query is local.
      OAUTH2_PROXY_HTTP_ADDRESS: `127.0.0.1:${OAUTH2_PROXY_PORT}`,
      OAUTH2_PROXY_PROVIDER: "oidc",
      OAUTH2_PROXY_REVERSE_PROXY: "true",
      // The client Kanidm has registered, under this service's own name.
      OAUTH2_PROXY_CLIENT_ID: SESSION_GATE,
      // A gated route's 401 arrives here through Traefik's errors middleware,
      // which preserves the status — so the sign-in handler's own redirect is
      // never sent and the page has to move the browser itself. That page is the
      // only reason for a custom directory: each template is taken from it only
      // when the file is present, and the built-in one is used otherwise.
      OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR: OAUTH2_TEMPLATES_DIR,
      // It proxies nothing: Traefik asks it a yes/no question and routes the
      // request itself, so the only upstream is a bare 202 for the "yes".
      OAUTH2_PROXY_UPSTREAMS: "static://202",
      OAUTH2_PROXY_SESSION_STORE_TYPE: "cookie",
      OAUTH2_PROXY_COOKIE_SECURE: "true",
      OAUTH2_PROXY_COOKIE_HTTPONLY: "true",
      OAUTH2_PROXY_COOKIE_SAMESITE: "lax",
      // A browser prefetcher or a second tab starts a second flow, and one CSRF
      // cookie for both means whichever finishes second fails its token
      // exchange. Per-request cookies let them run concurrently.
      OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST: "true",
      // Kanidm enforces PKCE for OAuth2 clients.
      OAUTH2_PROXY_CODE_CHALLENGE_METHOD: "S256",
      // `X-Auth-Request-User` carries Kanidm's `preferred_username`, so a
      // downstream service that trusts the header matches its own usernames
      // rather than email addresses.
      OAUTH2_PROXY_USER_ID_CLAIM: "preferred_username",
      // Kanidm decides who may hold an account at all; a second list of
      // permitted mail domains here would be a copy of that decision.
      OAUTH2_PROXY_EMAIL_DOMAINS: "*",
      OAUTH2_PROXY_SKIP_PROVIDER_BUTTON: "false",
      OAUTH2_PROXY_SET_XAUTHREQUEST: "true",
    },
    secretEnv: {
      OAUTH2_PROXY_COOKIE_SECRET: "cookie_secret",
      // Kanidm generates a client's secret and it cannot be set from outside, so
      // it is stored with the identity provider's credentials rather than with
      // the client's.
      OAUTH2_PROXY_CLIENT_SECRET: { item: "kanidm", field: "oauth2_proxy_client_secret" },
    },
    // It runs an OIDC client of its own and fetches the issuer's discovery
    // document at startup, exiting when it cannot — so the issuer answers before
    // this starts. Written rather than derived: `auth` says how this service's
    // own visitors are identified, and for the thing every other route asks that
    // is deliberately `open`. The gate being a client is the one place where the
    // two readings come apart.
    dependsOn: ["kanidm"],
    // It is the gate: every `auth: "edge"` route is sent here, and these are the
    // endpoints the proxy queries, redirects to and catches a refusal from.
    gate: GATE,
    /**
     * The issuer comes from whichever entry claims the identity role, asked for
     * the client this service is registered as — so neither end is spelled out
     * and the two cannot drift into naming different clients.
     *
     * The cookie is scoped to the whole zone rather than to this vhost — one
     * session across every gated subdomain is the point of a single forward-auth
     * gate — and the whitelist bounds where a post-login redirect may land,
     * which is what stops the `rd` parameter from being an open redirect off the
     * zone.
     */
    setup: ({ self, origin, installation, catalog }) => {
      const identity = catalog.identity;
      if (identity === undefined) {
        throw new Error(`${self.name} is a client of the identity provider, and none is deployed`);
      }
      const { domain } = installation.network;
      const own = origin();
      return {
        env: {
          OAUTH2_PROXY_OIDC_ISSUER_URL: identity.role.issuer(origin(identity.spec), self.name),
          OAUTH2_PROXY_REDIRECT_URL: GATE.callback(own),
          OAUTH2_PROXY_COOKIE_DOMAINS: `.${domain}`,
          OAUTH2_PROXY_WHITELIST_DOMAINS: `.${domain}`,
        },
        files: [
          // Templates are read once, when the proxy builds its page writer, so a
          // change to this one is a restart.
          {
            name: "sign-in",
            path: SIGN_IN_TEMPLATE_PATH,
            content: signInTemplate(GATE.submit(own)),
            restarts: true,
          },
        ],
      };
    },
  },
  {
    name: "vaultwarden",
    description: "Bitwarden-compatible password server",
    // 1.37.2
    image:
      "docker.io/vaultwarden/server@sha256:094b5689ed81549bd293418395c7cf495ae9d960fc2d4928cef2083ef913d912",
    port: VAULTWARDEN_PORT,
    // A password manager's clients sit on phones and laptops whose resolver is
    // whatever the network handed them; the name has to resolve everywhere,
    // and the record only says where the LAN is.
    publicDns: true,
    memory: { max: 48, measuredMb: 30, tier: "apps" },
    // The token is stored as its argon2 hash, which is what Vaultwarden wants in
    // `ADMIN_TOKEN` — the plaintext is the item's password field and is what a
    // person types into the admin page, so it is deliberately not read here.
    secretEnv: {
      ADMIN_TOKEN: "admin_token",
      // One field, two variables: the mailbox the invitation is sent from is
      // also the account the SMTP session authenticates as.
      SMTP_USERNAME: "smtp_email",
      SMTP_FROM: "smtp_email",
      SMTP_PASSWORD: "smtp_password",
    },
    env: {
      // Rocket defaults to :80 inside the container, which is not the port the
      // quadlet publishes to loopback or the one the route dials.
      ROCKET_PORT: String(VAULTWARDEN_PORT),
    },
    subdomain: "vault",
    // Its own login is a vault password, and the gate in front of it is a second
    // identity the LAN has to prove before the vault is even reachable.
    auth: "edge",
    egress: "open", // Sends invitation and 2FA mail via SMTP.
    // The database. Without this volume the vault lives and dies with the
    // container, and `backup: true` would snapshot an empty directory.
    mounts: ["/var/lib/vaultwarden:/data:Z"],
    backup: true,
    /**
     * `DOMAIN` is what Vaultwarden signs invitation links with and what its
     * WebAuthn relying-party id is derived from. Left unset it guesses from the
     * request, which breaks both. The SMTP relay rides along because Vaultwarden
     * refuses to start with `SMTP_FROM` set (the vault supplies it) and no
     * `SMTP_HOST` — half a mail configuration is a config error to it, not a
     * degraded mode.
     */
    setup: ({ origin, installation: { smtp } }) => ({
      env: {
        DOMAIN: origin(),
        SMTP_HOST: smtp.host,
        SMTP_PORT: String(smtp.port),
        SMTP_SECURITY: smtp.security,
      },
    }),
  },
  {
    name: "pihole",
    description: "Pi-hole: the LAN's resolver",
    // 2026.07.2. Digest-pinned: podman pulls it at runtime like any other
    // image, so nothing copies it into storage at install time and a digest
    // reference is free to use. Resolve with `scripts/pin-image.sh`.
    image:
      "docker.io/pihole/pihole@sha256:a29ad980775f38a8e7524a206ff9c125bc6fcfd9de8de1fc93d2de0671cc1d34",
    // The web UI's port. With host networking there is nothing to publish; this
    // is what the service binds and what Traefik will proxy.
    port: 8080,
    memory: { max: 160, measuredMb: 61, tier: "core" },
    // Answers the LAN on :53, and per-client statistics need the real source
    // address rather than a bridge's.
    egress: "host",
    // The LAN's resolver, so :53 is the one service port that is not reached
    // through Traefik. Host networking means the container's ports are the
    // host's, and both transports are needed: UDP for ordinary queries, TCP for
    // the answers that do not fit and for zone-transfer-shaped clients.
    ingress: { lanTcp: [53], lanUdp: [53], meshTcp: [53], meshUdp: [53] },
    subdomain: "pihole",
    publicDns: true,
    // The gate is the UI's whole authentication: the password below is
    // deliberately empty, because the route is the only way in.
    auth: "edge",
    env: {
      FTLCONF_dns_upstreams: `127.0.0.1#${UNBOUND.port}`,
      FTLCONF_dns_listeningMode: "all",
      // Host networking means the container's ports are the host's, and Pi-hole
      // defaults its web server to 80 and 443 — which Traefik needs.
      FTLCONF_webserver_port: "8080o,[::]:8080o",
      FTLCONF_database_maxDBdays: "7",
      // Explicitly empty, which is Pi-hole's "no password": the gate is on the
      // only path that reaches this UI — the packet filter admits :53 alone, so
      // :8080 is loopback-and-Traefik territory. Left unset, Pi-hole would
      // invent a random password and show a login screen behind the gate; the
      // restored pihole.toml's old hash does not survive either, because a
      // forced env value overwrites the stored setting.
      FTLCONF_webserver_api_password: "",
    },
    mounts: [`${PIHOLE_DATA_DIR}:/etc/pihole:Z`],
    // The whole LAN waits on this one, so "started" is not good enough. The
    // check is a query for Pi-hole's own name, which is the actual contract:
    // +norecurse so it tests this resolver rather than the internet behind it.
    healthCmd: "dig +norecurse +retry=0 @127.0.0.1 pi.hole",
    backup: true,
    // It is the resolver: every deployed vhost's LAN record is a line this
    // writes, into the directory dnsmasq's `hostsdir` watches.
    setup: ({ installation: { network }, catalog }) => {
      // One line per deployed vhost — a service's or a remote's, both pointing
      // at the proxy. `publicHosts` needs nothing of its own here — every name
      // in it already names a subdomain one of these entries claims, and only
      // says that name should skip Traefik's allowlist, not that it resolves
      // to something else.
      const lines = vhosts(catalog).map(
        (entry) => `${network.lanAddress} ${entry.subdomain}.${network.domain}`,
      );
      return {
        files: [
          {
            name: "hosts",
            path: `${PIHOLE_DATA_DIR}/hosts/keel.list`,
            // dnsmasq re-reads `hostsdir` on change (inotify) — proven live on
            // the board, a three-second turnaround with no reload and no
            // restart. Restarting Pi-hole for one record would be LAN DNS
            // downtime to add a line.
            restarts: false,
            content:
              [
                "# Written by the deploy from the catalog — do not edit by hand.",
                "# Pi-hole's own local DNS records live in its web UI, not here.",
                ...lines,
              ].join("\n") + "\n",
          },
        ],
      };
    },
  },
];

/**
 * The two catalogs as one list, refusing a name that occurs twice.
 *
 * A service's name is its container, its unit, its subdomain and its state
 * directory, so a second entry claiming one does not shadow the first: it deploys
 * a unit over it and mounts the same `/var/lib` into a different image. Pure and
 * exported so the refusal is a test rather than something a deploy discovers.
 *
 * Generic over `ServiceSpec` and `RemoteSpec` alike: both are named entries from
 * the same two files, and a remote sharing a name with a service is refused
 * elsewhere, by `deploymentGaps`, where the reason — one Traefik namespace — is.
 */
export function composeCatalog<T extends { name: string }>(
  example: readonly T[],
  local: readonly T[],
): readonly T[] {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const [where, entries] of [
    ["src/config/services.ts", example],
    ["src/config/services.local.ts", local],
  ] as const) {
    for (const spec of entries) {
      const first = seen.get(spec.name);
      if (first === undefined) seen.set(spec.name, where);
      else if (first === where) duplicates.push(`'${spec.name}' (twice in ${where})`);
      else duplicates.push(`'${spec.name}' (${first} and ${where})`);
    }
  }
  if (duplicates.length > 0) {
    throw new Error(
      `two catalog entries claim one service name: ${duplicates.join(", ")} — a name is the ` +
        "container, the unit, the subdomain and the state directory, so rename one of them",
    );
  }
  return [...example, ...local];
}

/**
 * What every consumer iterates. The example catalog first, this installation's
 * own after it; order is the reading order and nothing else derives from it —
 * the backup set and the packet filter's reload both sort what they are given.
 */
export const SERVICES: readonly ServiceSpec[] = composeCatalog(EXAMPLE_SERVICES, LOCAL_SERVICES);

/**
 * Keel ships no route to somebody else's machine — a `RemoteSpec` names an
 * address, and a committed one would be one stranger's infrastructure published
 * as everybody's example.
 */
export const EXAMPLE_REMOTES: readonly RemoteSpec[] = [];

/** The two remote catalogs as one list, the same way the service ones compose. */
export const REMOTES: readonly RemoteSpec[] = composeCatalog(EXAMPLE_REMOTES, LOCAL_REMOTES);
