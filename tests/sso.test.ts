/**
 * The login flow, as the rules that make it one.
 *
 * The gate answers an unauthenticated forward-auth query with 401 and Traefik
 * copies a non-2xx auth response to the client, so `sso-auth` on its own shows
 * the browser a 401 and no login page. The bodies that turn it into one are in
 * the golden; what is held here is the shape, for any gated service, and the two
 * facts about the gate that a wrong value would break silently: which client it
 * asks the issuer about, and which address it asks from.
 *
 * The last describe holds the same shape over a vhost that carries several
 * routers, because who may reach a name is the vhost's property and never a
 * router's — a second router must not be a way past the gate or the allowlist.
 * A router may narrow what its vhost admits and never widen it, which is the one
 * asymmetry in that rule and the last test in the file.
 */

import { describe, expect, it } from "vitest";

import { renderTraefikRoute } from "../src/adapters/traefik";
import { INSTALLATION } from "../src/config/installation";
import { SERVICES } from "../src/config/services";
import { catalogOf, runSetup, type ServiceSpec } from "../src/config/spec";
import { renderQuadlet } from "../src/render/quadlet";
import { HOUSE } from "./house";
import { chainMiddlewares, routerMiddlewares, routersOf, servicesOf } from "./routeYaml";

const CATALOG = catalogOf(SERVICES);
const GATE = CATALOG.gate!;
const DOMAIN = HOUSE.network.domain;

describe("the gate", () => {
  const setup = runSetup(GATE.spec, HOUSE, CATALOG);
  const quadlet = renderQuadlet(GATE.spec, setup?.env);
  const env = Object.fromEntries(
    quadlet
      .split("\n")
      .filter((line) => line.startsWith("Environment="))
      .map((line) => {
        const body = line.slice("Environment=".length);
        const split = body.indexOf("=");
        return [body.slice(0, split), body.slice(split + 1)];
      }),
  );

  it("asks the issuer about the client it says it is", () => {
    // Kanidm's issuer is a path named for the client, so the two cannot be
    // allowed to drift into naming different clients.
    expect(env.OAUTH2_PROXY_OIDC_ISSUER_URL.endsWith(`/${env.OAUTH2_PROXY_CLIENT_ID}`)).toBe(true);
    expect(env.OAUTH2_PROXY_OIDC_ISSUER_URL.startsWith(`https://`)).toBe(true);
    expect(env.OAUTH2_PROXY_OIDC_ISSUER_URL).toContain(`.${DOMAIN}/`);
  });

  it("reaches the identity provider from an address the allowlist admits", () => {
    // Every route carries `internal-only`, which matches on the client's
    // address. Sharing the host's network stack is what makes the gate's own
    // requests come from the LAN address rather than from a bridge — and the
    // same rule holds for any entry that runs a client of its own.
    expect(quadlet).toContain("Network=host");
    expect(env.OAUTH2_PROXY_HTTP_ADDRESS.startsWith("127.0.0.1:")).toBe(true);
    for (const spec of SERVICES.filter((candidate) => candidate.auth === "oidc")) {
      expect(spec.egress, spec.name).toBe("host");
    }
  });

  it("composes the installation's half beside the entry's, never over it", () => {
    // Two owners for one value would be resolved by whichever the renderer
    // happened to write last; the real catalog is held to it before a deploy
    // runs into the refusal.
    expect(() => renderQuadlet(GATE.spec, { OAUTH2_PROXY_PROVIDER: "other" })).toThrow(
      /both its spec and extraEnv/,
    );
    for (const spec of SERVICES) {
      const own = runSetup(spec, INSTALLATION, CATALOG);
      for (const variable of Object.keys(own?.env ?? {})) {
        expect(spec.env?.[variable], `${spec.name}: ${variable}`).toBeUndefined();
      }
    }
  });
});

describe("the login redirect", () => {
  /** Not in the catalog: what is asserted is the shape, for any gated service. */
  const gated: ServiceSpec = {
    name: "gated",
    description: "fixture",
    image: `example.test/gated@sha256:${"0".repeat(64)}`,
    port: 9001,
    memory: { max: 32, tier: "apps" },
    subdomain: "gate",
    auth: "edge",
  };
  const open: ServiceSpec = { ...gated, name: "open", subdomain: "open", auth: "open" };
  const route = (candidate: ServiceSpec) =>
    renderTraefikRoute(candidate, { domain: DOMAIN, gate: GATE }) ?? "";

  it("refuses to write a gated route with no gate to send it to", () => {
    // The route would name a middleware nothing defines: Traefik refuses to build
    // the router, the vhost stops answering, and the reason is in a log nobody
    // reads. Failing here is the loud version of the same fact.
    expect(() => renderTraefikRoute(gated, { domain: DOMAIN })).toThrow(/no gate was resolved/);
  });

  it("puts the errors middleware ahead of the gate and keeps the allowlist", () => {
    // The other order is the bare 401 again: a middleware only sees the response
    // of what follows it. And two independent gates: forward-auth proves who,
    // the allowlist proves from where. Neither substitutes for the other.
    expect(chainMiddlewares(route(gated))).toEqual(["oauth2-errors-gated", "sso-auth"]);
    expect(routerMiddlewares(route(gated))).toEqual(["internal-only", "oauth2-chain-gated"]);
  });

  it("leaves an ungated route with none of it", () => {
    // `open` is a claim about who may reach the service: a login page in front
    // of a wall panel is an outage, not a hardening. Still allowlisted — an
    // address is not an identity, and neither replaces the other.
    const rendered = route(open);
    expect(rendered).not.toContain("oauth2-");
    expect(rendered).not.toContain("sso-auth");
    expect(routerMiddlewares(rendered)).toEqual(["internal-only"]);
  });
});

describe("a vhost that carries several routers", () => {
  /**
   * Not in the catalog: the shape, for any entry whose paths do not all end at
   * one upstream — gRPC on a cleartext HTTP/2 backend, the REST API on the same
   * port, everything else on another container's.
   */
  const split: ServiceSpec = {
    name: "split",
    description: "fixture",
    image: `example.test/split@sha256:${"0".repeat(64)}`,
    port: 9101,
    memory: { max: 32, tier: "apps" },
    subdomain: "split",
    auth: "edge",
    routers: [
      { name: "grpc", match: "PathPrefix(`/rpc.Service/`)", scheme: "h2c", priority: 100 },
      { name: "api", match: "PathPrefix(`/api`)", priority: 100 },
      { name: "", port: 9102, priority: 1 },
    ],
  };
  const route = (candidate: ServiceSpec) =>
    renderTraefikRoute(candidate, { domain: DOMAIN, gate: GATE }) ?? "";

  it("gives each one a router, an upstream of its own and the priority it declared", () => {
    // The catch-all would otherwise swallow the API: Traefik's default priority
    // is the length of the rule, which is an order nobody wrote down. And the
    // gRPC backend is dialled `h2c` — over a plain HTTP/1 upstream an agent's
    // registration fails on the content type, which is a runtime error and not
    // a routing one.
    const routers = routersOf(route(split));
    expect(Object.keys(routers)).toEqual(["split-grpc", "split-api", "split"]);
    expect(Object.values(routers).map((router) => router.priority)).toEqual([100, 100, 1]);
    expect(routers["split-grpc"].rule).toBe(
      `Host(\`split.${DOMAIN}\`) && PathPrefix(\`/rpc.Service/\`)`,
    );
    expect(routers.split.rule).toBe(`Host(\`split.${DOMAIN}\`)`);
    expect(servicesOf(route(split))).toEqual({
      "split-grpc": "h2c://127.0.0.1:9101",
      "split-api": "http://127.0.0.1:9101",
      split: "http://127.0.0.1:9102",
    });
  });

  it("carries the vhost's allowlist and gate on every one of them", () => {
    // The rule that would rot silently: the allowlist and the chain are keyed to
    // the name a request arrives on, so a router that skipped either would be a
    // path past both — reachable by anyone who sets the Host header, and past
    // the gate that proves who is asking.
    for (const [name, router] of Object.entries(routersOf(route(split)))) {
      expect(router.middlewares, name).toEqual(["internal-only", "oauth2-chain-split"]);
    }
    // And a public vhost drops the allowlist on all of them together, never on
    // one: it is one name, admitted or not.
    const published = renderTraefikRoute(split, {
      domain: DOMAIN,
      publicHosts: ["split"],
      gate: GATE,
    })!;
    for (const [name, router] of Object.entries(routersOf(published))) {
      expect(router.middlewares, name).toEqual(["oauth2-chain-split"]);
    }
  });

  it("keeps the allowlist on a narrowed router where the vhost dropped it", () => {
    // The one direction a router may differ from its vhost. A public name is
    // answerable from anywhere by definition, and some path under it has no
    // business being — the unauthenticated call that claims a coordinator's
    // first account. `reach: "internal"` puts the allowlist back on that router
    // and on no other, so the siblings stay published and the narrowed one is
    // reachable from the LAN and the mesh alone.
    const narrowed: ServiceSpec = {
      ...split,
      auth: "open",
      routers: [
        { name: "setup", match: "PathPrefix(`/api/setup`)", priority: 200, reach: "internal" },
        ...split.routers!,
      ],
    };
    const published = routersOf(
      renderTraefikRoute(narrowed, { domain: DOMAIN, publicHosts: ["split"], gate: GATE })!,
    );
    expect(published["split-setup"].middlewares).toEqual(["internal-only"]);
    for (const name of ["split-grpc", "split-api", "split"]) {
      expect(published[name].middlewares, name).toEqual([]);
    }
    // And nothing declared on a router widens the vhost: on a name that never
    // opted out, every router carries the allowlist and the narrowed one is no
    // different from its siblings.
    const internal = routersOf(renderTraefikRoute(narrowed, { domain: DOMAIN, gate: GATE })!);
    for (const [name, router] of Object.entries(internal)) {
      expect(router.middlewares, name).toEqual(["internal-only"]);
    }
  });

  it("is the derived single router again for an entry that declares none", () => {
    // `routers` is an addition and never a rewrite: an entry that names none
    // renders exactly the router it always did — its own name, its own port, and
    // no priority for Traefik's default to disagree with. The bytes of every
    // deployed entry's file are held in the golden.
    const bare = route({ ...split, routers: undefined });
    expect(Object.keys(routersOf(bare))).toEqual(["split"]);
    expect(routersOf(bare).split.priority).toBeUndefined();
    expect(servicesOf(bare)).toEqual({ split: "http://127.0.0.1:9101" });
    expect(routerMiddlewares(bare)).toEqual(["internal-only", "oauth2-chain-split"]);
    expect(chainMiddlewares(bare)).toEqual(["oauth2-errors-split", "sso-auth"]);
  });
});
