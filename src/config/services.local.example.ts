/**
 * Copy this file to `src/config/services.local.ts` and put your own services in
 * it — in place of the entry below, which is a real service and would be
 * deployed as it stands.
 *
 * `services.ts` is the example catalog: a resolver with ad blocking, a proxy
 * holding a wildcard certificate, an identity provider, the gate in front of
 * every route, and a password manager. Those five are what keel *is*, so they are
 * committed and everybody's. Everything you run on top of them is yours, and
 * lives here — gitignored, because a catalog naming one installation's services
 * would be published with the repository and would fail a clone that runs
 * something else.
 *
 * An entry here is a `ServiceSpec` like any other: the quadlet, the unit, the
 * memory cap, the route, the ports the packet filter admits, the backup path and
 * the OIDC client all derive from it, and `SERVICES` is this list appended to the
 * example one. Nothing distinguishes the two halves downstream.
 *
 * There are two ways to write one, and both are below. A literal entry is the
 * general case and the only honest form for somebody else's product, whose
 * environment is whatever that product reads. A stamped entry —
 * `houseApp(…)` from `src/config/templates/houseApp.ts` — is for an application
 * you built, which shares a shape with the others you built: one port, one
 * SQLite file, one vhost, one login. It returns a plain `ServiceSpec`, so the
 * two forms are the same thing by the time anything reads them.
 *
 * The one live entry below is a real service, deliberately: it renders, deploys
 * and shows the shape. Delete it once you have your own.
 */

import { type RemoteSpec, type ServiceSpec } from "./spec";

export const LOCAL_SERVICES: readonly ServiceSpec[] = [
  {
    name: "memos",
    description: "Notes, as an example of a service you would add yourself",
    // The `stable` tag as of 2026-07-26, resolved with `scripts/pin-image.sh`.
    // Digests are never hand-typed: a well-formed placeholder passes every check
    // in this repository while pinning nothing.
    image:
      "ghcr.io/usememos/memos@sha256:71a5b4738d1bed96e92112004054f0888e92791b64eb78afd79077c96e6f9327",
    // What the server listens on inside the container. The quadlet publishes it
    // to the host's loopback; the proxy is the only listener facing the LAN.
    port: 5230,
    // Measure before you tighten this: `systemd-cgtop -1 -n1 --order=memory` on
    // the host, and keep the cap clear of what the service actually uses. The
    // apps tier is where memory pressure is resolved, so a cap that fires here
    // costs this service and never the resolver or the proxy.
    memory: { max: 96, tier: "apps" },
    // `https://notes.<your domain>`. Defaults to the service's own name when the
    // field is absent, and `null` means a service with no web surface at all.
    subdomain: "notes",
    // The forward-auth gate answers for it, so the only way in is a Kanidm login
    // — which is what a service with its own weak account list wants in front of
    // it. `open` would leave the route's IP allowlist as the only bound.
    auth: "edge",
    // The image's own data path. Everything under /var/lib/<name> on the host is
    // what a restore brings back, which is why the snapshot set derives from it.
    mounts: ["/var/lib/memos:/var/opt/memos:Z"],
    backup: true,
  },
  // The stamped form, for an application of your own. It is a comment rather
  // than a live entry because what it derives is this deployment's own shape — a
  // tag its CI moves rather than a digest, `/data` under `:Z,U` for an image
  // running as uid 1000, a `session_key` field on the app's own vault item — and
  // no published image is any of that. So a real digest here would pin an image
  // the stamp does not fit, and the only images it does fit are ones built by
  // their own owner's CI, which a committed file may not name. Somebody else's
  // product is the literal entry above; this is what bringing your own over
  // looks like. `yarn spec <name>` prints everything it expands to, and
  // uncommenting it needs the import as well:
  //
  //   import { houseApp } from "./templates/houseApp";
  //
  // houseApp({
  //   name: "atlas",
  //   description: "The next thing you build — one image, one port, one database",
  //   // Its own CI pushes `main`: a tag rather than a digest, which the deploy
  //   // resolves to a digest when it runs.
  //   image: "ghcr.io/you/atlas:main",
  //   port: 3010,
  //   // `measuredMb` is what it actually uses on the board —
  //   // `systemd-cgtop -1 -n1 --order=memory` — and the cap is that with room
  //   // for a burst. The measurement is required here because it is the only
  //   // thing the budget test can hold the cap to.
  //   memory: { max: 96, measuredMb: 30 },
  //   // The gate in front of the route is the login, and the app signs its own
  //   // cookie with the derived `SESSION_KEY` afterwards. This is what an app
  //   // arrives on: it keeps the internal bridge, so it reaches neither the
  //   // internet nor any other service's loopback port.
  //   //
  //   // `auth: "oidc"` instead — with `identityItem: "kanidm"`, the item the
  //   // provider keeps its generated client secrets on — gives the app its own
  //   // client, and with it the host's network stack, because the flow's back
  //   // channel goes to the issuer's vhost and that answers the LAN and the mesh
  //   // rather than a bridge. In the host's namespace the app can also dial every
  //   // other service's loopback port directly, past each route's allowlist and
  //   // past the gate, so it is worth choosing rather than defaulting to.
  //   auth: "edge",
  //   // Whatever your app reads these out of. The names and the values are the
  //   // application's own: no template guesses them, and none checks them.
  //   // `0.0.0.0` because a bridged container's published port forwards into its
  //   // own namespace, where loopback is the container talking to itself.
  //   env: { ATLAS_LISTEN: "0.0.0.0:3010", ATLAS_DB: "/data/atlas.db" },
  // }),
];

// A route to a machine this network reaches but the board does not run: no
// image, no unit, no cap and no backup, only the vhost. Put one here for a
// service on another box in the house, the way the old repository's plain
// Traefik routers did.
export const LOCAL_REMOTES: readonly RemoteSpec[] = [];
