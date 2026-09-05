/**
 * Everything this repository says in Traefik's dialect.
 *
 * Three things, all of them the proxy's own vocabulary rather than any service's:
 * its two configuration files, the dynamic-config file that is one service's
 * route, and the certificate store — which is a store and not an interface, so
 * whatever needs a certificate out of it reads `acme.json` itself, with a program
 * that lives here because its knowledge is Traefik's file format.
 *
 * `TRAEFIK_PROXY` at the bottom is the whole surface: an entry claims it, and the
 * deploy layer asks the role rather than this module. Swapping the proxy is then
 * writing a second module of this shape — no catalog entry, no renderer and no
 * provider spells a Traefik-shaped string.
 */

import { FALLBACK_DNS } from "../config/keel";
import {
  type Auth,
  type Claimed,
  type GateRole,
  type ProxyRole,
  type RemoteSpec,
  type RouteContext,
  type ServiceSpec,
  subdomainOf,
} from "../config/spec";

/**
 * Traefik's own configuration directory, mounted at the same path inside the
 * container and out. The static file is read once at start; the dynamic
 * directory is watched, and is where every route file lands.
 */
export const TRAEFIK_DIR = "/etc/traefik";
export const TRAEFIK_STATIC_PATH = `${TRAEFIK_DIR}/traefik.yml`;
export const TRAEFIK_DYNAMIC_DIR = `${TRAEFIK_DIR}/dynamic`;
export const TRAEFIK_MIDDLEWARES_PATH = `${TRAEFIK_DYNAMIC_DIR}/middlewares.yml`;

/** The unit, for anything that has to be ordered after the proxy. */
const TRAEFIK_UNIT = "traefik.service";

/** The resolver's name in the static config, referenced by the entry point's TLS. */
const CERT_RESOLVER = "cloudflare";

/**
 * Where acme.json lives, inside the container and out — the mount is identical
 * on both sides, so one path is the whole truth. Exported because it is also a
 * store other things read: Kanidm's certificate is extracted from it.
 */
export const ACME_STORAGE = "/var/lib/traefik/acme.json";

/** Named once here and by the routes that ask for a TLS upstream. */
export const INSECURE_TRANSPORT = "insecure-loopback";

/**
 * The entry point the `/ping` endpoint answers on, and the port it binds.
 *
 * An explicit one, because Traefik's own default for `ping.entryPoint` is the
 * internal `traefik` entry point at `:8080` — and this proxy runs on the host's
 * network stack, where `:8080` is a host port some other service owns. Bound to
 * loopback for the same reason: the only caller is a health check inside this
 * container, and the LAN reaches this proxy on 443.
 *
 * Traefik exits when an entry point cannot bind, so this number is a hard
 * requirement on the host and the port-collision test can only hold it against
 * *this* catalog. A board still running services from somewhere else has
 * listeners this repository cannot see — check with `ss -tlnp` before the first
 * deploy that restarts the proxy.
 */
const PING_ENTRY_POINT = "ping";
export const TRAEFIK_PING_PORT = 9080;

/**
 * What "the proxy is answering" is, as a command the image can run.
 *
 * `traefik healthcheck` re-reads the static configuration, finds the ping entry
 * point above and queries it — so the port is stated once, in the file both
 * halves read. It means answering and nothing more: it succeeds while the ACME
 * order is still in flight, which is the honest signal, and the wait for a
 * *certificate* belongs to whoever needs one.
 */
export const TRAEFIK_HEALTH_CMD = "traefik healthcheck";

/**
 * How long a service that reads a certificate out of the store may wait for the
 * first one to appear.
 *
 * The DNS-01 challenge writes a TXT record and then waits for public resolvers
 * to agree it is visible before Let's Encrypt is asked to validate, so a fresh
 * host's first certificate is minutes rather than seconds after the proxy starts
 * answering. Bounded rather than open-ended: a token that cannot write the zone
 * never produces a certificate, and a reader blocked forever on one is a boot
 * that never finishes.
 */
export const CERT_SETTLE_SECONDS = 600;

/** The forward-auth middleware, defined here and named by every gated chain. */
const FORWARD_AUTH = "sso-auth";

/**
 * The zone the wildcard covers, the ranges the allowlist admits and the gate the
 * forward-auth middleware queries — everything Traefik's two configuration files
 * need that the catalog cannot state on its own.
 *
 * The gate is optional because a proxy is useful without one: with no gate
 * deployed there is no forward-auth middleware to define, and nothing may then
 * declare `auth: "edge"` — a precondition the deploy layer checks before a route
 * can name a middleware that does not exist.
 */
export type TraefikOptions = {
  domain: string;
  allowedRanges: readonly string[];
  gate?: GateRole;
  acmeEmail?: string;
};

/**
 * The static file. A change here restarts Traefik — that is what "static" means
 * — which is why it is folded into the service's restart trigger while the
 * dynamic files are not.
 *
 * There is no `:80` entry point, and nothing in the image opens 80. The wildcard
 * certificate comes from a **DNS-01** challenge, which is answered by writing a
 * TXT record through Cloudflare's API, so there is no HTTP challenge to serve and
 * nothing to redirect. That is the property Traefik was chosen for.
 */
export function traefikStatic({ domain, acmeEmail }: TraefikOptions): string {
  const lines = [
    "global:",
    "  checkNewVersion: false",
    "  sendAnonymousUsage: false",
    "",
    "log:",
    "  level: INFO",
    "",
    "ping:",
    // Named rather than left to default onto the `traefik` entry point at
    // :8080, which under host networking is a port another service binds.
    `  entryPoint: ${PING_ENTRY_POINT}`,
    "",
    "entryPoints:",
    `  ${PING_ENTRY_POINT}:`,
    `    address: "127.0.0.1:${TRAEFIK_PING_PORT}"`,
    "    http:",
    // Nothing is routed from here, so this is only what stops the edge-header
    // warning the websecure entry point's own setting exists to answer.
    "      aliasHeadersStrategy: delete",
    "  websecure:",
    '    address: ":443"',
    "    http:",
    // A header whose name merely aliases another — `X_Auth_Request_User` for
    // `X-Auth-Request-User` — is read as the header it aliases by anything that
    // derives variable names from header names. Since every gated route is
    // gated by exactly those headers, a client that sets the alias would be
    // handing itself an identity. Deleted at the edge rather than trusted
    // anywhere.
    "      aliasHeadersStrategy: delete",
    "      tls:",
    // Set on the entry point rather than per router: a route file then says
    // `tls: {}` and gets the wildcard, so no route has to name the resolver.
    `        certResolver: ${CERT_RESOLVER}`,
    "        domains:",
    `          - main: "${domain}"`,
    "            sans:",
    `              - "*.${domain}"`,
    "",
    "providers:",
    "  file:",
    `    directory: ${TRAEFIK_DYNAMIC_DIR}`,
    // Routes are files this layer writes and deletes, so the proxy has to notice
    // without being restarted.
    "    watch: true",
    "",
    "certificatesResolvers:",
    `  ${CERT_RESOLVER}:`,
    "    acme:",
    ...(acmeEmail === undefined ? [] : [`      email: "${acmeEmail}"`]),
    `      storage: ${ACME_STORAGE}`,
    "      dnsChallenge:",
    `        provider: ${CERT_RESOLVER}`,
    // Public resolvers for the propagation check specifically: asking this
    // host's own resolver whether the TXT record is visible asks Pi-hole's
    // cache, which is not the question.
    "        resolvers:",
    ...FALLBACK_DNS.map((address) => `          - "${address}:53"`),
    "",
  ];
  return lines.join("\n");
}

/**
 * The middlewares every route names, and the transport a TLS upstream uses.
 * Written to the watched directory, so they arrive without an outage.
 *
 * `internal-only` is attached by the route renderer unless a subdomain is named
 * public, so this is where "deny by default" is actually enforced: Traefik
 * matches on the Host header, and without an address check any stranger who sets
 * that header reaches the service behind it.
 */
export function traefikMiddlewares({ allowedRanges, gate }: TraefikOptions): string {
  const lines = [
    "http:",
    "  middlewares:",
    "    internal-only:",
    "      ipAllowList:",
    "        sourceRange:",
    ...allowedRanges.map((range) => `          - "${range}"`),
    ...(gate === undefined
      ? []
      : [
          `    ${FORWARD_AUTH}:`,
          "      forwardAuth:",
          `        address: "${gate.forwardAuth}"`,
          // Traefik is the only thing that can reach the gate, and it is the one
          // setting the forwarded headers.
          "        trustForwardHeader: true",
          "        authResponseHeaders:",
          ...gate.responseHeaders.map((header) => `          - ${header}`),
          // The sign-in page the gate returns to an unauthenticated request is
          // the largest body this ever forwards. Unbounded, it is memory
          // exhaustion an unauthenticated client can ask for.
          "        maxResponseBodySize: 65536",
        ]),
    "  serversTransports:",
    `    ${INSECURE_TRANSPORT}:`,
    // For a service that terminates TLS itself with its own certificate on
    // loopback. There is no name to verify and no network to intercept: the
    // connection never leaves the host.
    "      insecureSkipVerify: true",
    "",
  ];
  return lines.join("\n");
}

/**
 * What a route file is actually built from — a service's own vhost fields read
 * down to them, or a remote's, so one renderer serves both without caring which
 * kind of entry it was handed.
 *
 * `upstreams` is one per router: a vhost derives a single one, and an entry that
 * declares `routers` says what they are.
 */
type Routed = {
  name: string;
  subdomain: string;
  auth: Auth;
  upstreams: readonly Upstream[];
};

/**
 * One router and the load balancer it forwards to, under one name — Traefik
 * needs the router to name a service, and a pair that could be named apart is a
 * pair that can be wired to the wrong half.
 *
 * `url` is always a full one: `http(s)://127.0.0.1:<port>` for a service,
 * `h2c://` where the backend speaks cleartext HTTP/2, the remote's own
 * otherwise. A remote's `tlsUpstream` is read off that URL's scheme rather than
 * off any field on the entry, so the two cannot disagree.
 */
type Upstream = {
  name: string;
  /** ANDed with the vhost's `Host()`; absent is the router that takes the rest. */
  match?: string;
  url: string;
  /** The upstream terminates TLS itself, so the transport skips verifying it. */
  tlsUpstream: boolean;
  /** Stated only by an entry that declared its routers. */
  priority?: number;
};

/** A `RemoteSpec` is the only one of the two with an `upstream` — no port to build one from. */
function isRemote(spec: ServiceSpec | RemoteSpec): spec is RemoteSpec {
  return "upstream" in spec;
}

/** The one shape `renderTraefikRoute` renders, or null for a service with no vhost. */
function routedOf(spec: ServiceSpec | RemoteSpec): Routed | null {
  if (isRemote(spec)) {
    return {
      name: spec.name,
      subdomain: spec.subdomain,
      auth: spec.auth,
      upstreams: [
        { name: spec.name, url: spec.upstream, tlsUpstream: spec.upstream.startsWith("https:") },
      ],
    };
  }
  const subdomain = subdomainOf(spec);
  if (subdomain === null) return null;
  const tlsUpstream = spec.tlsUpstream === true;
  const loopback = (port: number, scheme?: string): string =>
    `${scheme ?? (tlsUpstream ? "https" : "http")}://127.0.0.1:${port}`;
  return {
    name: spec.name,
    subdomain,
    auth: spec.auth,
    upstreams:
      spec.routers === undefined
        ? [{ name: spec.name, url: loopback(spec.port), tlsUpstream }]
        : spec.routers.map((router) => ({
            name: router.name === "" ? spec.name : `${spec.name}-${router.name}`,
            match: router.match,
            url: loopback(router.port ?? spec.port, router.scheme),
            // `h2c` is cleartext HTTP/2 — a scheme the upstream speaks, and never
            // the transport that skips verifying a certificate.
            tlsUpstream: tlsUpstream && router.scheme === undefined,
            priority: router.priority,
          })),
  };
}

/** The middleware a gated router actually names. */
function chainName(routed: Routed): string {
  return `oauth2-chain-${routed.name}`;
}

/**
 * The login redirect, as two middlewares per gated entry.
 *
 * The forward-auth middleware alone is a gate and not a login: the gate refuses
 * an unauthenticated query with a status, and Traefik copies a non-2xx auth
 * response straight to the client — so the browser is shown that bare status and
 * never reaches a sign-in page. Wrapping the gate in an `errors` middleware that
 * catches exactly the status it refuses with turns it into a fetch of the gate's
 * sign-in page, carrying the vhost the visitor was heading for so the flow can
 * return them there.
 *
 * The errors middleware calls a *service* rather than a router, and the one that
 * fronts the gate is the load balancer the gate's own route file defines — hence
 * the cross-file `@file` reference. Order inside the chain is what makes it work:
 * the errors middleware has to be ahead of the gate to see the refusal.
 */
function ssoMiddlewares(routed: Routed, domain: string, gate: Claimed<GateRole>): string[] {
  const errors = `oauth2-errors-${routed.name}`;
  return [
    "  middlewares:",
    `    ${errors}:`,
    "      errors:",
    "        status:",
    `          - "${gate.role.challengeStatus}"`,
    `        service: ${gate.spec.name}@file`,
    `        query: "${gate.role.challenge(`https://${routed.subdomain}.${domain}/`)}"`,
    `    ${chainName(routed)}:`,
    "      chain:",
    "        middlewares:",
    `          - ${errors}`,
    `          - ${FORWARD_AUTH}`,
  ];
}

/**
 * One Traefik dynamic-config file per entry, created and deleted with it. The
 * `internal-only` and `sso-auth` middlewares it references come from Traefik's
 * own catalog entry, written to the same watched directory; a gated entry's own
 * two middlewares are defined in the route file itself, so they are created and
 * removed with the only thing that uses them.
 *
 * Attaching `internal-only` here rather than on the container means it is applied
 * in code with a test behind it. Public TCP 443 is forwarded so the NetBird
 * coordinator is reachable, and Traefik matches on Host header rather than source
 * IP — so a route that forgets the allowlist answers anyone who sets the header.
 * Deny by default, opt out by name.
 *
 * An entry that declares `routers` gets one router and one load balancer per
 * router it names, all under the same `Host()` and all carrying the same
 * middlewares: what a request may reach follows from the vhost it arrived on,
 * and a second router on that vhost is a division of its paths rather than a
 * second answer to who may ask.
 */
export function renderTraefikRoute(
  spec: ServiceSpec | RemoteSpec,
  { domain, publicHosts = [], gate }: RouteContext,
): string | null {
  const routed = routedOf(spec);
  if (routed === null) return null;
  const { name, subdomain, upstreams } = routed;

  const gated = routed.auth === "edge";
  // A chain naming a middleware nothing defines is a router Traefik refuses to
  // build: the vhost stops answering, with the reason in a log nobody is reading.
  if (gated && gate === undefined) {
    throw new Error(`${name} routes through the edge gate, and no gate was resolved`);
  }
  const middlewares = [
    ...(publicHosts.includes(subdomain) ? [] : ["internal-only"]),
    ...(gated ? [chainName(routed)] : []),
  ];

  const host = `Host(\`${subdomain}.${domain}\`)`;

  const lines = [
    "http:",
    "  routers:",
    ...upstreams.flatMap((upstream) => [
      `    ${upstream.name}:`,
      `      rule: "${upstream.match === undefined ? host : `${host} && ${upstream.match}`}"`,
      "      entryPoints:",
      "        - websecure",
      `      service: ${upstream.name}`,
      ...(upstream.priority === undefined ? [] : [`      priority: ${upstream.priority}`]),
      ...(middlewares.length > 0
        ? ["      middlewares:", ...middlewares.map((mw) => `        - ${mw}`)]
        : []),
      "      tls: {}",
    ]),
    "  services:",
    ...upstreams.flatMap((upstream) => [
      `    ${upstream.name}:`,
      "      loadBalancer:",
      ...(upstream.tlsUpstream ? [`        serversTransport: ${INSECURE_TRANSPORT}`] : []),
      "        servers:",
      `          - url: "${upstream.url}"`,
    ]),
    ...(gated && gate ? ssoMiddlewares(routed, domain, gate) : []),
  ];

  return `${lines.join("\n")}\n`;
}

/** Where the route lands, in the directory the file provider watches. */
export function routePath(spec: ServiceSpec | RemoteSpec): string {
  return `${TRAEFIK_DYNAMIC_DIR}/${spec.name}.yaml`;
}

/**
 * The interpreter the extraction script is run by, named rather than left to the
 * shebang: the script sits in /etc, whose label systemd will not execute
 * directly. Reading it as an argument to python needs no label at all.
 */
const CERT_EXTRACT_INTERPRETER = "/usr/bin/python3";

/** What reads the store, and where its messages land in the journal. */
type CertExtraction = {
  /** Where chain.pem and key.pem are written. The reader's, not the proxy's. */
  dir: string;
  /** Prefix on the script's own log lines — the unit a reader runs it from. */
  journalTag: string;
  /** How long to wait for the store's first certificate before failing. */
  settleSeconds: number;
};

/**
 * Pull the wildcard certificate out of `acme.json` into `certDir`, waiting for
 * one to be there.
 *
 * Traefik keeps every certificate it holds in that one file, which is a store
 * rather than an interface: nothing else can read a certificate out of it, and
 * there is no hook to run when one is renewed. So this parses it, which is why it
 * belongs to Traefik and not to whichever service needs the result.
 *
 * The wildcard is found by looking for a `*` in a certificate's SANs rather than
 * by naming the zone, so the script holds no installation data at all.
 *
 * **The wait is the whole point of running it.** Whoever reads a certificate out
 * of the store pulls this in and is ordered after it, and the proxy answers
 * minutes before the DNS-01 challenge completes — so returning "not yet" as a
 * success would hand the reader an empty directory and let it fail on its own
 * missing file. Blocking until the certificate is there makes the file a
 * precondition instead of a race, and the bound is what keeps a token that can
 * never write the zone from becoming a boot that never finishes: the deadline
 * passes, this fails by name, and the reader's own start fails after it.
 */
function certExtractionScript({ dir, journalTag, settleSeconds }: CertExtraction): string {
  return `#!/usr/bin/env python3
import base64, json, os, sys, time

ACME = "${ACME_STORAGE}"
CERT_DIR = "${dir}"
DEADLINE_SECONDS = ${settleSeconds}
POLL_SECONDS = 5


def wildcard():
    """The stored certificate whose SANs carry a wildcard, or None."""
    try:
        with open(ACME) as f:
            raw = f.read()
    except FileNotFoundError:
        return None
    if not raw.strip():
        return None
    try:
        acme = json.loads(raw)
    except json.JSONDecodeError:
        # The proxy rewrites the store in place, so a read can land mid-write.
        return None
    for resolver in acme.values():
        if not isinstance(resolver, dict):
            continue
        for cert in resolver.get("Certificates") or []:
            if any("*" in s for s in cert.get("domain", {}).get("sans", [])):
                return cert
    return None


deadline = time.monotonic() + DEADLINE_SECONDS
while True:
    cert = wildcard()
    if cert is not None:
        os.makedirs(CERT_DIR, exist_ok=True)
        chain_path = os.path.join(CERT_DIR, "chain.pem")
        key_path = os.path.join(CERT_DIR, "key.pem")
        with open(chain_path, "w") as f:
            f.write(base64.b64decode(cert["certificate"]).decode())
        with open(key_path, "w") as f:
            f.write(base64.b64decode(cert["key"]).decode())
        os.chmod(key_path, 0o600)
        print(f"${journalTag}: wrote wildcard cert to {CERT_DIR}")
        sys.exit(0)
    if time.monotonic() >= deadline:
        break
    print(f"${journalTag}: no wildcard in {ACME} yet, waiting")
    sys.stdout.flush()
    time.sleep(POLL_SECONDS)

print(
    f"${journalTag}: no wildcard cert in {ACME} after {DEADLINE_SECONDS}s — "
    "the DNS-01 challenge has not completed",
    file=sys.stderr,
)
sys.exit(1)
`;
}

/**
 * Traefik as a role, for the entry that is it: the unit to order against, the
 * store its certificates land in, and how one service's route is written.
 *
 * This is the whole surface the rest of the repository reads a proxy through, so
 * swapping the proxy is writing a second value of this shape beside a second
 * catalog entry — no renderer, provider or other entry names Traefik.
 */
export const TRAEFIK_PROXY: ProxyRole = {
  unit: TRAEFIK_UNIT,
  certificateStore: {
    product: "Traefik",
    path: ACME_STORAGE,
    interpreter: CERT_EXTRACT_INTERPRETER,
    settleSeconds: CERT_SETTLE_SECONDS,
    extract: certExtractionScript,
  },
  route: renderTraefikRoute,
  routePath,
};
