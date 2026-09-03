/**
 * What the packet filter admits and what the proxy routes, held to the rules a
 * wrong file would break silently.
 */

import { describe, expect, it } from "vitest";

import { renderTraefikRoute } from "../src/adapters/traefik";
import { INSTALLATION } from "../src/config/installation";
import { SERVICES } from "../src/config/services";
import { catalogOf, runSetup, subdomainOf } from "../src/config/spec";
import { renderAll } from "../src/render";
import { NFT_SERVICES_PATH, renderNftPorts, renderNftServices } from "../src/render/nftPorts";
import { chainMiddlewares, routerMiddlewares } from "./routeYaml";

const CATALOG = catalogOf(SERVICES);

/** The proxy's own files, composed by the entry that claims the proxy role. */
const traefikFiles = (): Record<string, string> => {
  const setup = runSetup(CATALOG.proxy!.spec, INSTALLATION, CATALOG);
  expect(setup?.files, "traefik").toBeDefined();
  return Object.fromEntries((setup?.files ?? []).map((file) => [file.name, file.content]));
};

describe("ports the packet filter admits", () => {
  it("asks for nothing on behalf of a service behind the proxy", () => {
    // Everything with a vhost is reached through Traefik's 443. A port for one
    // of them would be a port opened to something nothing dials.
    for (const spec of SERVICES) {
      if (subdomainOf(spec) !== null && spec.ingress === undefined) {
        expect(renderNftPorts(spec), spec.name).toBeNull();
      }
    }
  });

  it("opens 80 nowhere", () => {
    // DNS-01 needs no HTTP challenge, which is the documented reason for
    // choosing this proxy. A redirect would be the only other excuse, and there
    // is no entry point to redirect from.
    for (const candidate of SERVICES) {
      expect(renderNftPorts(candidate) ?? "", candidate.name).not.toMatch(/\b80\b/);
    }
    // An entry point's address, not the substring: the proxy's own ping endpoint
    // binds :9080, and a check for `:80` would read that as port 80.
    expect(traefikFiles().static).not.toMatch(/address:\s*"[^"]*:80"/);
  });

  it("is one file for the host, written even when it admits nothing, in the glob the image reads", () => {
    // `nft -f` merges and Pulumi deletes after it updates, so a per-service file
    // belonging to a retired service would still be on disk when the reload
    // re-reads the glob — and that reload would re-admit the port it was run to
    // close. One file makes retiring a service an update of what the reload
    // reads; a body of "no rules" that became an absent file would be a
    // deletion again. Sorted by name, because the body is the reload's trigger
    // and a flush takes every other table on the box with it.
    const body = renderNftServices(SERVICES);
    for (const candidate of SERVICES) {
      const own = renderNftPorts(candidate);
      if (own !== null) expect(body, candidate.name).toContain(own);
    }
    expect(renderNftServices([...SERVICES].reverse())).toBe(body);
    const quiet = renderNftServices(SERVICES.filter((s) => s.ingress === undefined));
    expect(quiet).not.toContain("elements =");
    expect(quiet.startsWith("#")).toBe(true);
    const conf = renderAll().tree.get("/etc/sysconfig/nftables.conf")?.content ?? "";
    expect(conf).toContain('include "/etc/keel/nft.d/*.nft"');
    expect(NFT_SERVICES_PATH.startsWith("/etc/keel/nft.d/")).toBe(true);
    // After the ranges keel-firstboot writes, so an address set exists before a
    // port set is matched against it.
    expect(NFT_SERVICES_PATH > "/etc/keel/nft.d/10-ranges.nft").toBe(true);
  });
});

describe("the proxy's routes", () => {
  it("name no middleware nothing defines", () => {
    // A route naming a middleware the proxy has no definition for is a router
    // Traefik refuses to build: the vhost fails closed, silently. The shared two
    // live in the proxy's own dynamic file; the chain a gated route names is
    // defined in the same file as the router, and its leaf is the shared one.
    const shared = [...traefikFiles().middlewares.matchAll(/^ {4}([\w-]+):$/gm)].map((m) => m[1]);
    expect(shared).toContain("internal-only");
    expect(shared).toContain("sso-auth");
    for (const spec of SERVICES) {
      const route = renderTraefikRoute(spec, {
        domain: INSTALLATION.network.domain,
        publicHosts: INSTALLATION.publicHosts,
        gate: CATALOG.gate,
      });
      if (route === null) continue;
      const own = [...route.matchAll(/^ {4}([\w-]+):$/gm)].map((m) => m[1]);
      for (const name of [...routerMiddlewares(route), ...chainMiddlewares(route)]) {
        expect([...shared, ...own], `${spec.name}: ${name}`).toContain(name);
      }
    }
  });
});
