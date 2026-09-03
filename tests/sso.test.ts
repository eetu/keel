/**
 * The login flow, as the rules that make it one.
 *
 * The gate answers an unauthenticated forward-auth query with 401 and Traefik
 * copies a non-2xx auth response to the client, so `sso-auth` on its own shows
 * the browser a 401 and no login page. The bodies that turn it into one are in
 * the golden; what is held here is the shape, for any gated service, and the two
 * facts about the gate that a wrong value would break silently: which client it
 * asks the issuer about, and which address it asks from.
 */

import { describe, expect, it } from "vitest";

import { renderTraefikRoute } from "../src/adapters/traefik";
import { INSTALLATION } from "../src/config/installation";
import { SERVICES } from "../src/config/services";
import { catalogOf, runSetup, type ServiceSpec } from "../src/config/spec";
import { renderQuadlet } from "../src/render/quadlet";
import { HOUSE } from "./house";
import { chainMiddlewares, routerMiddlewares } from "./routeYaml";

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
