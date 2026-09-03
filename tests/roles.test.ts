/**
 * What one entry needs of another, and what happens when it is not there.
 *
 * A role is resolved by presence rather than by name, so the failures worth
 * catching are the ones a name would have made obvious: two entries claiming the
 * same capability, and a deployed set missing one something in it depends on.
 * Both fail where nobody is looking — a route naming a middleware the proxy has
 * no definition for is a router it refuses to build, so the vhost fails closed
 * and silently — which is why they are checked while the plan is still on screen.
 */

import { describe, expect, it } from "vitest";

import { SERVICES } from "../src/config/services";
import {
  catalogOf,
  certSyncName,
  dependencyNames,
  deploymentGaps,
  orderServices,
  roles,
  type ServiceSpec,
  subdomainOf,
} from "../src/config/spec";
import { renderQuadlet } from "../src/render/quadlet";

/** Nothing from the catalog: what is asserted is the rule, for any entry. */
const plain = (name: string, extra: Partial<ServiceSpec> = {}): ServiceSpec => ({
  name,
  description: "fixture",
  image: `example.test/${name}@sha256:${"0".repeat(64)}`,
  port: 9000,
  memory: { max: 32, tier: "apps" },
  subdomain: null,
  auth: "open",
  ...extra,
});

const PROXY = catalogOf(SERVICES).proxy!;

describe("the roles a catalog resolves to", () => {
  it("gives the whole catalog exactly one of each", () => {
    // Resolution is what the deploy layer, the golden and every test builds on,
    // so a catalog that grew a second proxy has to fail here rather than there.
    const resolved = roles(SERVICES);
    expect(resolved.proxy, "proxy").toBeDefined();
    expect(resolved.identity, "identity").toBeDefined();
    expect(resolved.gate, "gate").toBeDefined();
  });

  it("resolves them by what an entry is, not by what it is called", () => {
    // The proxy has no vhost of its own and the other two do; nothing here
    // matches a name, which is the property the roles exist for.
    expect(subdomainOf(roles(SERVICES).proxy!.spec)).toBeNull();
    expect(roles(SERVICES).proxy!.role.route).toBeTypeOf("function");
    expect(roles(SERVICES).identity!.role.issuer("https://idm.example.test", "client")).toBe(
      "https://idm.example.test/oauth2/openid/client",
    );
  });

  it("refuses two claimants, naming both", () => {
    // Which of two proxies a route is written for has no answer this could pick
    // that would not be a guess, so it picks neither.
    const second = plain("second-proxy", { proxy: PROXY.role });
    expect(() => roles([PROXY.spec, second])).toThrow(
      new RegExp(`${PROXY.spec.name} and second-proxy both claim the proxy role`),
    );
  });

  it("hands a setup the list it was resolved from", () => {
    // A reading the three roles do not cover still comes from the deployed set
    // rather than from the whole catalog.
    const subset = [PROXY.spec];
    expect(catalogOf(subset).services).toEqual(subset);
  });
});

describe("what a deployed set is missing", () => {
  it("passes the real catalog, deployed whole", () => {
    expect(deploymentGaps(catalogOf(SERVICES))).toEqual({ errors: [], warnings: [] });
  });

  it("refuses an edge-gated service with no gate deployed", () => {
    const gated = plain("gated", { subdomain: "gated", auth: "edge" });
    const { errors } = deploymentGaps(catalogOf([PROXY.spec, gated]));
    expect(errors.join("\n")).toMatch(/claims the gate role.*edge gate: gated/s);
    // Named as the silent failure it is, because that is why it is fatal.
    expect(errors.join("\n")).toMatch(/fails closed silently/);
  });

  it("refuses an OIDC client with no identity provider deployed", () => {
    const client = plain("client", { subdomain: "client", auth: "oidc" });
    const { errors } = deploymentGaps(catalogOf([PROXY.spec, client]));
    expect(errors.join("\n")).toMatch(/claims the identity role.*own: client/s);
  });

  it("refuses an OIDC client that cannot reach the issuer it is a client of", () => {
    // The back channel leaves from the service's own address, and every route's
    // allowlist admits the LAN and the mesh — so a client on a bridge deploys
    // clean and fails at its first login. Caught here rather than by the
    // template alone, because a literal entry can name the same combination.
    const identity = SERVICES.find((spec) => spec.identity !== undefined)!;
    const client = plain("client", { subdomain: "client", auth: "oidc", egress: "internal" });
    const { errors } = deploymentGaps(catalogOf([PROXY.spec, identity, client]));
    expect(errors.join("\n")).toMatch(/OIDC client of their own from a bridge: client/);
    expect(errors.join("\n")).toMatch(/fails at first use/);
    // On the host's stack it is the same entry with no gap at all.
    expect(
      deploymentGaps(catalogOf([PROXY.spec, identity, { ...client, egress: "host" as const }]))
        .errors,
    ).toEqual([]);
  });

  it("refuses a certificate reader with no store to read from", () => {
    const reader = plain("reader", { certificates: { dir: "/etc/reader/certs" } });
    // No proxy at all.
    expect(deploymentGaps(catalogOf([reader])).errors.join("\n")).toMatch(
      /no deployed entry claims the proxy role, and these read a certificate out of one: reader/,
    );
    // A proxy that keeps no store is the same gap with a different sentence: the
    // sync would have nothing to parse.
    const storeless = plain("storeless", { proxy: { ...PROXY.role, certificateStore: undefined } });
    expect(deploymentGaps(catalogOf([reader, storeless])).errors.join("\n")).toMatch(
      /storeless claims the proxy role and keeps no certificate store/,
    );
  });

  it("only warns about a vhost with no proxy deployed", () => {
    // Nothing is written, the service answers on loopback, and the name simply
    // does not resolve yet — a staged deploy, not a mistake.
    const app = plain("app", { subdomain: "app" });
    const gaps = deploymentGaps(catalogOf([app]));
    expect(gaps.errors).toEqual([]);
    expect(gaps.warnings.join("\n")).toMatch(/no deployed proxy routes to these vhosts: app/);
  });
});

describe("the order a deployed set is started in", () => {
  const IDENTITY = catalogOf(SERVICES).identity!;

  const order = (specs: readonly ServiceSpec[], whole: readonly ServiceSpec[] = specs) =>
    orderServices(catalogOf(specs), whole).map((spec) => spec.name);

  it("puts every service after everything it depends on", () => {
    // The real catalog, which is what a full deploy walks. Asserted as positions
    // rather than as a fixed list: what matters is the relation, and a second
    // valid order is not a regression.
    const names = order(SERVICES);
    expect([...names].sort()).toEqual(SERVICES.map((spec) => spec.name).sort());
    const catalog = catalogOf(SERVICES);
    for (const spec of SERVICES) {
      for (const dep of dependencyNames(spec, catalog)) {
        expect(names.indexOf(dep), `${spec.name} after ${dep}`).toBeLessThan(
          names.indexOf(spec.name),
        );
      }
    }
  });

  it("derives a client's edge from the identity provider it asks", () => {
    // Nothing is written down: running an OIDC client of its own is what puts
    // the service after the issuer, because the discovery document is fetched at
    // startup and a client that cannot reach its issuer exits.
    const client = plain("client", { auth: "oidc", egress: "host" });
    expect(dependencyNames(client, catalogOf([IDENTITY.spec, client]))).toEqual([
      IDENTITY.spec.name,
    ]);
    expect(order([client, IDENTITY.spec])).toEqual([IDENTITY.spec.name, "client"]);
  });

  it("derives a certificate reader's edge from the store it reads", () => {
    const reader = plain("reader", { certificates: { dir: "/etc/reader/certs" } });
    expect(dependencyNames(reader, catalogOf([PROXY.spec, reader]))).toEqual([PROXY.spec.name]);
  });

  it("derives nothing from a vhost", () => {
    // Deliberately: a route file needs nothing running to be written, and the
    // rule would be a cycle — the resolver has a vhost, and the proxy is started
    // after the resolver because its challenge resolves through it.
    const app = plain("app", { subdomain: "app" });
    expect(dependencyNames(app, catalogOf([PROXY.spec, app]))).toEqual([]);
  });

  it("puts every edge it hands Pulumi on the unit as well", () => {
    // A derived edge that reached only the deploy would order the first start
    // and nothing after it: every reboot would race, and a client that came up
    // before its issuer would crash-loop through `Restart=always` until the
    // issuer answered. The quadlet is rendered with the same roles, so what
    // systemd is told is what the plan was built from.
    const client = plain("client", { auth: "oidc", egress: "host" });
    const deployed = catalogOf([IDENTITY.spec, client]);
    expect(dependencyNames(client, deployed)).toEqual([IDENTITY.spec.name]);
    expect(renderQuadlet(client, {}, deployed)).toMatch(
      new RegExp(`^After=.* ${IDENTITY.spec.name}\\.service`, "m"),
    );
    // And with no deployment in hand it says only what the entry wrote down.
    expect(renderQuadlet(client)).not.toContain(`${IDENTITY.spec.name}.service`);
  });

  it("refuses a cycle, naming the loop", () => {
    const a = plain("a", { dependsOn: ["b"] });
    const b = plain("b", { dependsOn: ["c"] });
    const c = plain("c", { dependsOn: ["a"] });
    expect(() => order([a, b, c])).toThrow(/cycle: a -> b -> c -> a/);
  });

  it("refuses a dependency no catalog entry is called", () => {
    const app = plain("app", { dependsOn: ["typo"] });
    expect(() => order([app])).toThrow(/app depends on 'typo', which no catalog entry is called/);
  });

  it("refuses a dependency this host's services list leaves out", () => {
    // The other way a name can be missing, and a different sentence: the entry
    // exists, the host does not list it, and a dependency is ordering rather
    // than selection — so nothing here quietly pulls it in.
    const absent = plain("absent");
    const app = plain("app", { dependsOn: ["absent"] });
    expect(() => order([app], [app, absent])).toThrow(
      /app depends on absent, which this host's services list leaves out/,
    );
  });
});

describe("the one-shot a certificate declaration implies", () => {
  it("names it after the service that reads the files", () => {
    expect(certSyncName(plain("thing", { certificates: { dir: "/etc/thing/certs" } }))).toBe(
      "thing-cert-sync",
    );
  });

  it("derives nothing for a service that declares no certificates", () => {
    // No declaration, no units, and no `Wants=` on a unit that does not exist.
    expect(certSyncName(plain("thing"))).toBeNull();
  });

  it("is wanted and ordered by the quadlet that declared it, and by nothing else", () => {
    // The one-shot exists because of the declaration, so the quadlet pulls it in
    // and waits for it; `Wants=` alone would let both start at once, and a
    // quadlet declaring no certificates wants nothing but the network.
    const quadlet = renderQuadlet(plain("thing", { certificates: { dir: "/etc/thing/certs" } }));
    expect(quadlet).toMatch(/^Wants=network-online\.target thing-cert-sync\.service$/m);
    expect(quadlet).toMatch(/^After=.* thing-cert-sync\.service$/m);
    expect(renderQuadlet(plain("thing"))).toMatch(/^Wants=network-online\.target$/m);
  });
});
