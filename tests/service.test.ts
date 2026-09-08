/**
 * What every entry in the composed catalog is held to, whichever file it came
 * from and whatever it says: one owner per port, one vhost per name, a quadlet
 * that publishes to loopback and caps nothing, an environment systemd will
 * accept, and no module outside the catalog that knows a service by name.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderTraefikRoute, TRAEFIK_PING_PORT } from "../src/adapters/traefik";
import { INSTALLATION } from "../src/config/installation";
import { UNBOUND } from "../src/config/keel";
import { PROFILES, selectProfile } from "../src/config/profiles";
import { EXAMPLE_SERVICES, SERVICES } from "../src/config/services";
import {
  catalogOf,
  type Ingress,
  isSecretsPath,
  metricsSecretsPath,
  publicRecords,
  type RemoteSpec,
  runSetup,
  secretFields,
  secretFileShape,
  secretsPath,
  type ServiceSpec,
  subdomainOf,
} from "../src/config/spec";
import { type ServiceSecretFile } from "../src/config/types";
import { publicProxyIngress } from "../src/render/nftPorts";
import {
  NETWORK_INTERFACES,
  NETWORK_NAMES,
  renderNetworks,
  renderQuadlet,
  renderTimer,
  timerPath,
} from "../src/render/quadlet";
import { routersOf } from "./routeYaml";

const NETWORK = INSTALLATION.network;

/** The roles the whole catalog resolves to, which is what a full deploy sees. */
const CATALOG = catalogOf(SERVICES);

describe("host declarations", () => {
  it.each(Object.entries(INSTALLATION.hosts))("%s names services the catalog has", (_, host) => {
    // A host's `services` list is the whole selector, so a name no entry is
    // called would be a service that silently never arrives. The deploy refuses
    // it at plan start; this catches it before a plan is ever run. And the RAM
    // figure is what selects the profile every cap is priced from.
    const names = SERVICES.map((spec) => spec.name);
    for (const name of host.services ?? []) expect(names).toContain(name);
    expect(PROFILES).toContain(selectProfile(host.ramMb));
  });
});

/**
 * Every host port a set of entries claims, and what two claimants of one look
 * like.
 *
 * One namespace per transport, because a host port is a host port however it is
 * bound: a host-network service binds it on every address, and a bridge
 * service's `PublishPort` binds it on loopback. Both would collide with each
 * other, with sshd, and with the resolver the image runs.
 *
 * A service may claim the same port twice — Traefik's 443 is both what it binds
 * and what the filter admits — so a collision is two *owners*. A scheduled entry
 * claims nothing: it runs to completion, no process ever binds its number, and
 * reserving one for a listener that does not exist would report the first real
 * user of it as a clash.
 */
function portConflicts(specs: readonly ServiceSpec[]): readonly string[] {
  const claims: Record<"tcp" | "udp", Map<number, string>> = { tcp: new Map(), udp: new Map() };
  const conflicts: string[] = [];
  const claim = (proto: "tcp" | "udp", port: number, owner: string) => {
    const held = claims[proto].get(port);
    if (held !== undefined && held !== owner) conflicts.push(`${proto}/${port}: ${held}, ${owner}`);
    claims[proto].set(port, owner);
  };

  claim("tcp", 22, "sshd");
  // Loopback-only, but still the host's port, and Pi-hole's upstream.
  claim("tcp", UNBOUND.port, "unbound");
  claim("udp", UNBOUND.port, "unbound");
  // The proxy's ping endpoint, which its own health check dials. Loopback, but
  // the proxy runs on the host's network stack — and Traefik's default would
  // have taken :8080, which the resolver's web UI binds.
  claim("tcp", TRAEFIK_PING_PORT, CATALOG.proxy!.spec.name);

  const ingressSets: readonly (readonly [keyof Ingress, "tcp" | "udp"])[] = [
    ["lanTcp", "tcp"],
    ["lanUdp", "udp"],
    ["meshTcp", "tcp"],
    ["meshUdp", "udp"],
    ["worldTcp", "tcp"],
    ["worldUdp", "udp"],
  ];
  for (const spec of specs) {
    if (spec.schedule === undefined) claim("tcp", spec.port, spec.name);
    for (const [key, proto] of ingressSets) {
      for (const port of spec.ingress?.[key] ?? []) claim(proto, port, spec.name);
    }
  }
  return conflicts;
}

describe("the catalog as a whole", () => {
  it("gives every port on the host exactly one owner", () => {
    expect(portConflicts(SERVICES)).toEqual([]);
  });

  it("assigns each service a distinct subdomain", () => {
    const names = SERVICES.map(subdomainOf).filter((name) => name !== null);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe.each(SERVICES)("$name quadlet", (spec) => {
  const quadlet = renderQuadlet(spec);

  it("binds to loopback only", () => {
    if ((spec.egress ?? "internal") === "host") {
      // Host networking has no `PublishPort` to narrow the bind: what the
      // service is told to listen on is a host address, so a wildcard puts it on
      // the LAN address with only the packet filter in front — while the proxy
      // dials it on loopback and needs nothing more. A wildcard is accepted for
      // exactly the port the entry asks the packet filter to admit, because an
      // entry that answers the LAN directly says so twice — once to the
      // application, once to the filter — and either half alone is a mistake: a
      // bind nothing admits is a listener nothing reaches, and a port nothing
      // binds admits traffic to nothing.
      const admitted = new Set(Object.values(spec.ingress ?? {}).flat());
      for (const [variable, value] of Object.entries(spec.env ?? {})) {
        const wildcard = /0\.0\.0\.0(?::(\d+))?/.exec(value);
        if (wildcard === null) continue;
        expect(admitted.has(Number(wildcard[1])), `${spec.name}: ${variable}=${value}`).toBe(true);
      }
      return;
    }
    expect(quadlet).toContain(`PublishPort=127.0.0.1:${spec.port}:${spec.port}`);
  });

  it("places itself in a slice but sets no memory cap", () => {
    // Exactly one mechanism owns the numbers: the drop-in written beside it.
    expect(quadlet).toMatch(/^Slice=keel-(core|apps)\.slice$/m);
    expect(quadlet).not.toContain("MemoryMax=");
    expect(quadlet).not.toContain("MemoryHigh=");
  });

  it("restricts egress unless the entry opts out", () => {
    const egress = spec.egress ?? "internal";
    if (egress === "host") {
      // Host networking opts out of the restriction entirely, and publishes
      // nothing — the service binds the host's ports directly.
      expect(quadlet).toContain("Network=host");
      expect(quadlet).not.toContain("PublishPort=");
      return;
    }
    // The `.network` suffix points at the network quadlet, which is what makes
    // systemd create the network before the container asks for it. The bare
    // name would ask podman for a network nothing has created.
    expect(quadlet).toContain(`Network=${NETWORK_NAMES[egress]}.network`);
  });

  it("waits for greenboot's verdict before starting", () => {
    // /var/lib survives a greenboot rollback while the code that wrote it does
    // not, so a service must not write anything until the image is declared good.
    expect(quadlet).toContain("boot-complete.target");
  });

  it("references secrets by path and waits for them", () => {
    // Both blobs, whichever of them this entry has: one sealed from the vault
    // fields it names, one from an account another service issued it. Neither is
    // a value in the unit, and either is a reason to wait for the decrypt.
    const sealed = [secretsPath(spec), metricsSecretsPath(spec)].filter((path) => path !== null);
    if (sealed.length === 0) {
      expect(quadlet).not.toContain("EnvironmentFile=");
      return;
    }
    for (const path of sealed) expect(quadlet).toContain(`EnvironmentFile=${path}`);
    expect(quadlet).toContain("keel-secrets.service");
    // The spec carries field *names*; the values are read at deploy time and
    // sealed, so nothing here or in state is a plaintext.
    for (const { field } of Object.values(secretFields(spec))) {
      expect(quadlet).not.toContain(field);
    }
  });

  it("inlines no secret-looking environment", () => {
    for (const line of quadlet.split("\n").filter((l) => l.startsWith("Environment="))) {
      if (!/(password|secret|token|key)=/i.test(line)) continue;
      // A variable that reads like a credential may carry an empty value or a
      // path, and nothing else. Pi-hole disables its own auth with the first,
      // deliberately, because the proxy is the gate; Kanidm is told where its
      // TLS key sits with the second. Anything else would be the value itself.
      const value = line.slice(line.indexOf("=", "Environment=".length) + 1);
      expect(value === "" || value.startsWith("/"), line).toBe(true);
    }
  });
});

describe("an entry that runs on a schedule", () => {
  /**
   * A job, as a fixture. Nothing from either catalog: no committed entry runs on
   * a schedule and a local one is one house's, so the mechanism is asserted on a
   * declaration written here — which is also what makes these pass on a clean
   * clone.
   */
  const job = (extra: Partial<ServiceSpec> = {}): ServiceSpec => ({
    name: "job",
    description: "A job that runs and exits",
    image: `example.test/job@sha256:${"0".repeat(64)}`,
    // Nominal: nothing binds it, and `ServiceSpec.port` is not optional.
    port: 9100,
    memory: { max: 64, tier: "apps" },
    subdomain: null,
    auth: "open",
    schedule: "*-*-* 04,16:00 UTC",
    ...extra,
  });

  it("renders a one-shot that systemd can see the exit status of", () => {
    // `Type=oneshot` is the whole mechanism and not a label: quadlet's default
    // for a `.container` puts `--sdnotify=conmon -d` on the generated ExecStart,
    // which detaches — `podman run` returns 0 as soon as the container is up and
    // a failing job looks exactly like a working one. Stating the type makes
    // quadlet drop the `-d`, so the exit code arrives and a bad run leaves the
    // unit failed, which is the state the image's poller lists.
    const quadlet = renderQuadlet(job());
    expect(quadlet).toContain("Type=oneshot");
    // And a restart policy is a claim that the unit should be running, which
    // would turn every finished run into the next one.
    expect(quadlet).not.toContain("Restart=");
    expect(quadlet).not.toContain("RestartSec=");
    // `RemainAfterExit=yes` leaves the unit "started", and a timer's next
    // activation is refused against a unit in that state.
    expect(quadlet).not.toContain("RemainAfterExit");
    // The start timeout is the only bound on the run: systemd's default for a
    // one-shot is infinity, so a job wedged on an upstream would still be
    // running when its timer next fired.
    expect(quadlet).toContain("TimeoutStartSec=600");
  });

  it("is wanted by no target, so a schedule is not a boot", () => {
    // `[Install] WantedBy=multi-user.target` is what makes the generator want a
    // unit at every startup, which for a one-shot is a run on every reboot. The
    // timer beside it is the only thing that starts it.
    expect(renderQuadlet(job())).not.toContain("[Install]");
    expect(renderQuadlet(job())).not.toContain("WantedBy=");
  });

  it("publishes nothing, on a bridge as much as on the host", () => {
    // A forward into a namespace that exists for a few seconds a day is a rule
    // with nothing behind it, and the port it would name is nominal.
    expect(renderQuadlet(job({ egress: "internal" }))).not.toContain("PublishPort=");
    expect(renderQuadlet(job({ egress: "open" }))).not.toContain("PublishPort=");
    // And it keeps the bridge itself: egress is orthogonal to the schedule.
    expect(renderQuadlet(job({ egress: "open" }))).toContain(
      `Network=${NETWORK_NAMES.open}.network`,
    );
  });

  it("claims no host port, even one a real listener already owns", () => {
    // Nothing binds it, so nothing can collide with it — and reserving the
    // number would report the first real user of it as a clash. Asserted against
    // a port some deployed service does own, because that is the case a rule
    // written the other way would have failed on.
    for (const spec of SERVICES) {
      expect(portConflicts([...SERVICES, job({ port: spec.port })]), spec.name).toEqual([]);
    }
  });

  it("keeps everything an entry derives that is not about listening", () => {
    // The point of the field: a scheduled entry is a `ServiceSpec` and not a
    // kind of its own, so the cap, the slice, the sealed environment, the decrypt
    // it waits for and the mounts are all still derived from it.
    const quadlet = renderQuadlet(
      job({
        secretEnv: { API_KEY: "api_key" },
        mounts: ["/var/lib/job:/data:Z,U"],
      }),
    );
    expect(quadlet).toContain("Slice=keel-apps.slice");
    expect(quadlet).toContain("EnvironmentFile=/etc/secrets/job.env");
    expect(quadlet).toContain("keel-secrets.service");
    expect(quadlet).toContain("Volume=/var/lib/job:/data:Z,U");
    expect(quadlet).toContain("ExecStartPre=/usr/bin/mkdir -p /var/lib/job");
    // Still ordered behind greenboot's verdict: a job that wrote to /var/lib
    // before the image was declared good would leave data behind a rollback.
    expect(quadlet).toContain("boot-complete.target");
  });

  it("runs from a timer that waits for the clock", () => {
    // A board with no RTC boots at the image's build date and is stepped forward
    // by weeks. A persistent timer loaded before the step discards its stamp as
    // "in the future" and treats every calendar elapse inside the jump as
    // missed — a run on every boot — which is what this line prevents.
    const timer = renderTimer(job());
    expect(timer).toContain("After=time-sync.target");
    expect(timer).toContain("OnCalendar=*-*-* 04,16:00 UTC");
    expect(timer).toContain("Persistent=true");
    // The timer is the half with an [Install]: enabling it is what starts the
    // clock, and it activates `job.service` by default — the unit quadlet
    // generates — so neither half names the other.
    expect(timer).toContain("WantedBy=timers.target");
    expect(timer).not.toContain("Unit=");
    expect(timerPath(job())).toBe("/etc/systemd/system/job.timer");
  });

  it("has no timer to build for an entry that stays up", () => {
    expect(() => renderTimer(job({ schedule: undefined }))).toThrow(/no schedule/);
  });

  it("captures its output to a file, with its own logging kept out of it", () => {
    // The sink any third-party image can use: a job that prints its result needs
    // no egress to hand it over and no credential to do it with, and whatever
    // wants the result mounts the path read-only. `StandardError=journal` is not
    // a preference — systemd's default is to duplicate `StandardOutput=`, so
    // without it the run's own logging is interleaved into the document.
    const quadlet = renderQuadlet(job({ stdoutFile: "/var/lib/job/out/latest.json" }));
    expect(quadlet).toContain("StandardOutput=file:/var/lib/job/out/latest.json");
    expect(quadlet).toContain("StandardError=journal");
    // systemd creates the file and not the path to it, so a sink under a
    // directory nothing else makes is a unit that fails before the job runs.
    expect(quadlet).toContain("ExecStartPre=/usr/bin/mkdir -p /var/lib/job/out");
  });

  it("carries no health check, because there is nothing to be healthy", () => {
    // A `Type=oneshot` container asked to notify readiness fails outright, so
    // the renderer emits neither half. The declaration itself is refused by
    // name at plan time — see the deployment gaps.
    const quadlet = renderQuadlet(job({ healthCmd: "CMD true" }));
    expect(quadlet).not.toContain("HealthCmd=");
    expect(quadlet).not.toContain("Notify=healthy");
  });
});

describe("traefik routes", () => {
  const route = (spec: (typeof SERVICES)[number], publicHosts: readonly string[] = []) =>
    renderTraefikRoute(spec, { domain: NETWORK.domain, publicHosts, gate: CATALOG.gate });

  it.each(SERVICES)("$name is allowlisted, and gated exactly when the entry says", (spec) => {
    const rendered = route(spec);
    if (subdomainOf(spec) === null) {
      expect(rendered).toBeNull();
      return;
    }
    // The allowlist proves from where and the gate proves who; `open` means keel
    // adds no gate, not that the vhost answers anyone. The router names the
    // chain, never the forward-auth gate on its own: the bare gate answers 401
    // and the browser never reaches a login page. Every router on the vhost,
    // because an entry that divides its paths between upstreams carries the same
    // two on each of them — reachability is the vhost's property, not a name's.
    for (const [router, { middlewares }] of Object.entries(routersOf(rendered ?? ""))) {
      expect(middlewares[0], router).toBe("internal-only");
      expect(middlewares.includes(`oauth2-chain-${spec.name}`), router).toBe(spec.auth === "edge");
      expect(middlewares, router).not.toContain("sso-auth");
    }
    // A named public host is the one thing that drops the allowlist, and it
    // drops it from every router but one that narrows itself back to the LAN —
    // the only direction a router may differ from the vhost it answers on. A
    // path with no business being answered from the internet is what that is
    // for; nothing declared on a router can widen who reaches the name.
    const narrowed = new Set(
      (spec.routers ?? [])
        .filter((router) => router.reach === "internal")
        .map((router) => (router.name === "" ? spec.name : `${spec.name}-${router.name}`)),
    );
    for (const [router, { middlewares }] of Object.entries(
      routersOf(route(spec, [subdomainOf(spec)!]) ?? ""),
    )) {
      expect(middlewares.includes("internal-only"), router).toBe(narrowed.has(router));
    }
  });
});

describe("the resolver's hosts file", () => {
  // A remote is a vhost too, and this is the one place that has to know it —
  // the same LAN address, from `vhosts()` rather than from `catalog.services`.
  const remote: RemoteSpec = {
    name: "remote-fixture",
    description: "fixture",
    subdomain: "remote-fixture",
    upstream: "http://198.51.100.9:9000",
    auth: "open",
  };
  const catalog = catalogOf(SERVICES, [remote]);
  const pihole = SERVICES.find((spec) => spec.name === "pihole")!;
  const hosts = runSetup(pihole, INSTALLATION, catalog)?.files?.find(
    (file) => file.name === "hosts",
  );
  const lines = (hosts?.content ?? "")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));

  it("names exactly the deployed vhosts and remotes, each pointing at the LAN address", () => {
    const subdomains = [
      ...SERVICES.filter((spec) => subdomainOf(spec) !== null).map((spec) => subdomainOf(spec)!),
      remote.subdomain,
    ];
    expect(lines).toHaveLength(subdomains.length);
    for (const subdomain of subdomains) {
      expect(lines).toContain(`${NETWORK.lanAddress} ${subdomain}.${NETWORK.domain}`);
    }
  });

  it("names nothing for an entry with subdomain: null", () => {
    // Traefik itself: the one entry in the committed catalog with no vhost.
    const proxy = SERVICES.find((spec) => spec.subdomain === null)!;
    expect(lines.some((line) => line.endsWith(` ${proxy.name}.${NETWORK.domain}`))).toBe(false);
  });
});

describe("public DNS records", () => {
  // A remote can opt in the same way a service does, and one of these two does.
  const publicRemote: RemoteSpec = {
    name: "remote-public",
    description: "fixture",
    subdomain: "remote-public",
    upstream: "http://198.51.100.9:9000",
    auth: "open",
    publicDns: true,
  };
  const privateRemote: RemoteSpec = {
    name: "remote-private",
    description: "fixture",
    subdomain: "remote-private",
    upstream: "http://198.51.100.10:9000",
    auth: "open",
  };
  const catalog = catalogOf(EXAMPLE_SERVICES, [publicRemote, privateRemote]);
  const records = publicRecords(catalog, NETWORK);

  it("carries exactly the entries that opted in with publicDns: true, services and remotes alike", () => {
    const expected = [
      ...EXAMPLE_SERVICES.filter((spec) => spec.publicDns === true).map((spec) => spec.name),
      publicRemote.name,
    ].sort();
    expect(records.map((record) => record.name).sort()).toEqual(expected);
  });

  it("points every record at the LAN address, under the deployment's own domain", () => {
    for (const record of records) {
      expect(record.content).toBe(NETWORK.lanAddress);
      expect(record.fqdn.endsWith(`.${NETWORK.domain}`)).toBe(true);
    }
  });

  it("never names a service with subdomain: null", () => {
    const proxy = EXAMPLE_SERVICES.find((spec) => spec.subdomain === null)!;
    expect(records.some((record) => record.name === proxy.name)).toBe(false);
  });

  it("leaves out an entry that never set publicDns: true", () => {
    expect(records.some((record) => record.name === privateRemote.name)).toBe(false);
    const template = EXAMPLE_SERVICES.find((spec) => spec.name === "vaultwarden")!;
    const quiet = { ...template, name: "quiet", subdomain: "quiet", publicDns: false };
    const own = publicRecords(catalogOf([quiet]), NETWORK);
    expect(own.some((record) => record.name === quiet.name)).toBe(false);
  });
});

describe("podman networks", () => {
  it("are never Internal, pin their interface names and run no resolver", () => {
    // netavark's `Internal` severs the host too: a port published to loopback
    // forwards into a wall, so egress denial is the packet filter's forward
    // chain, which matches on the interface name pinned here. And aardvark-dns
    // binds <gateway>:53 on every network it serves while Pi-hole answers :53 on
    // every address — a network without DisableDNS fails every container that
    // joins it with "Address already in use".
    const tree = renderNetworks();
    for (const kind of ["internal", "open"] as const) {
      const content =
        tree.get(`/usr/share/containers/systemd/${NETWORK_NAMES[kind]}.network`)?.content ?? "";
      expect(content, kind).not.toContain("Internal=true");
      expect(content, kind).toContain(`InterfaceName=${NETWORK_INTERFACES[kind]}`);
      expect(content, kind).toContain("DisableDNS=true");
    }
  });
});

describe("one entry is the whole declaration", () => {
  // The property the catalog exists for: configuring a service is editing one
  // entry, plus values in the single INSTALLATION object when it has any. There
  // is nothing to register and no dispatch to extend, and these hold that shut.
  const root = fileURLToPath(new URL("../src", import.meta.url));
  // The catalog is three files: the committed example, this installation's own,
  // and the twin a fresh clone copies into place. Naming services is what all
  // three are for; everything else in `src/` is held to naming at most one.
  const catalogs = [
    "config/services.ts",
    "config/services.local.ts",
    "config/services.local.example.ts",
  ];
  const sources = readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts") && !catalogs.includes(name))
    .map((name) => [name, readFileSync(`${root}/${name}`, "utf8")] as const);
  const names = SERVICES.map((spec) => spec.name);
  const mentions = (source: string) =>
    names.filter((name) => new RegExp(`["']${name}["']`).test(source));

  it("keeps a service's configuration out of every other module", () => {
    // A module naming two services is a dispatch table, which is the shape this
    // catalog exists not to have. Naming one is a module about that service —
    // the units Kanidm's certificate needs — and that is its subject, not a
    // table it is the second half of.
    for (const [path, source] of sources) {
      expect(
        mentions(source).length,
        `${path}: ${mentions(source).join(", ")}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("names no service at all in a template", () => {
    // A template is a shape, and a shape that named a service would be a
    // template for one thing: what a stamped entry needs of another service it
    // takes as an argument or asks for by role.
    const templates = sources.filter(([path]) => path.startsWith("config/templates/"));
    expect(templates.length, "no template modules were scanned").toBeGreaterThan(0);
    for (const [path, source] of templates) expect(mentions(source), path).toEqual([]);
  });

  it("selects nothing by a service's name", () => {
    // Every `spec.name === "…"` branch is configuration that belongs on the
    // entry instead. What a service needs, a service says — and what one service
    // needs of another, it asks for by role.
    for (const [path, source] of sources) {
      for (const name of names.map((name) => `["']${name}["']`)) {
        expect(source, `${path}: ${name}`).not.toMatch(new RegExp(`\\.name\\s*[!=]==\\s*${name}`));
      }
    }
  });

  it("writes each file its setup composes once, at an absolute path", () => {
    // A file's name distinguishes a resource under the service, so two sharing
    // one would be a single resource written twice.
    for (const spec of SERVICES) {
      const files = runSetup(spec, INSTALLATION, CATALOG)?.files ?? [];
      for (const file of files) expect(file.path.startsWith("/"), file.path).toBe(true);
      expect(new Set(files.map((file) => file.name)).size).toBe(files.length);
    }
  });

  it("lands a file it generates key material for where the decrypt opens it, and names it", () => {
    // A blob written anywhere but `/etc/secrets` is written correctly and never
    // decrypted — the container then starts with its configuration missing while
    // the deploy reports success. And a generated file the container never names
    // is either dead weight or, worse, a mount whose source no file lands at,
    // which podman answers by creating a directory over it.
    for (const spec of SERVICES) {
      const setup = runSetup(spec, INSTALLATION, CATALOG);
      const files = setup?.secretFiles ?? [];
      const quadlet = renderQuadlet(spec, setup?.env, CATALOG);
      for (const file of files) {
        expect(isSecretsPath(file.path), file.path).toBe(true);
        expect(quadlet, `${spec.name}: ${file.path}`).toContain(file.path);
      }
      expect(new Set(files.map((file) => file.name)).size).toBe(files.length);
    }
  });
});

describe("the env files a container reads", () => {
  const template = EXAMPLE_SERVICES.find((spec) => spec.name === "vaultwarden")!;
  const account = {
    role: "readonly",
    env: { user: "HUB_USER", password: "HUB_PASSWORD" },
  } as const;

  it("adds one for a credential the deploy generates, beside the one it reads", () => {
    // Two files because two resources write them: the vault-read half is sealed
    // from field names on the entry, the generated half inside the resource that
    // creates the account. `keel-secrets.service` decrypts whatever `*.age` it
    // finds, so the second costs the device nothing — and the unit waits for
    // that one unit either way.
    const both = renderQuadlet({ ...template, name: "both", metricsAccount: account });
    expect(both).toContain("EnvironmentFile=/etc/secrets/both.env");
    expect(both).toContain("EnvironmentFile=/etc/secrets/both.metrics.env");
    expect(both).toContain("keel-secrets.service");
  });

  it("waits for the decrypt even when the generated one is all it has", () => {
    // An entry can hold an account and no vault fields at all: the ordering has
    // to follow from either file, not from `secretEnv` alone, or the container
    // starts before the blob beside it has been opened.
    const only = renderQuadlet({
      ...template,
      name: "only",
      secretEnv: undefined,
      metricsAccount: account,
    });
    expect(only).not.toContain("EnvironmentFile=/etc/secrets/only.env\n");
    expect(only).toContain("EnvironmentFile=/etc/secrets/only.metrics.env");
    expect(only).toContain("keel-secrets.service");
  });

  it("waits for the decrypt for a secret it mounts rather than reads as environment", () => {
    // A configuration file whose body is key material is a `Volume=` line and no
    // `EnvironmentFile=` at all. Without this the container can start before the
    // blob beside it is opened, and podman answers a bind mount whose source is
    // missing by creating a directory over it — which the next decrypt cannot
    // replace, so the service never reads its own configuration again.
    const mounted = renderQuadlet({
      ...template,
      name: "mounted",
      secretEnv: undefined,
      mounts: ["/etc/secrets/mounted.config.yaml:/etc/app/config.yaml:ro"],
    });
    expect(mounted).not.toContain("EnvironmentFile=");
    expect(mounted).toContain("keel-secrets.service");
  });

  it("names one for an entry that declares no account, and none for an entry with neither", () => {
    // The property the committed golden rests on: a spec that declares nothing
    // new renders exactly what it rendered before.
    const plain = renderQuadlet({ ...template, name: "plain" });
    expect(plain.match(/^EnvironmentFile=/gm)).toHaveLength(1);
    const bare = renderQuadlet({ ...template, name: "bare", secretEnv: undefined });
    expect(bare).not.toContain("EnvironmentFile=");
    expect(bare).not.toContain("keel-secrets.service");
  });
});

describe("the environment systemd is handed", () => {
  it("holds every variable name to what an Environment= key may be", () => {
    // Letters, digits and underscores after a letter or an underscore, which is
    // all systemd's generator accepts. It rejects the rest on the device, after
    // a reboot, having passed the deploy that wrote the unit — and a service
    // name may hold a dash where a variable may not. The secret half is held to
    // the same shape, and its item and field names to the vault's.
    for (const spec of SERVICES) {
      const setup = runSetup(spec, INSTALLATION, CATALOG);
      for (const variable of [...Object.keys(spec.env ?? {}), ...Object.keys(setup?.env ?? {})]) {
        expect(variable, `${spec.name}: ${variable}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      }
      for (const [variable, source] of Object.entries(secretFields(spec))) {
        expect(variable, spec.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
        expect(source.field, spec.name).toMatch(/^[a-z][a-z0-9_.@-]*$/);
        expect(source.item, spec.name).toMatch(/^[a-z][a-z0-9_.-]*$/);
      }
    }
  });

  it("quotes a value with whitespace, escapes what the quoting claims, and leaves a plain one bare", () => {
    // systemd splits an unquoted Environment= value on whitespace; a JSON blob
    // must arrive as one variable, quotes and backslashes intact. A plain value
    // stays bare so deployed units do not churn.
    const spec = {
      ...EXAMPLE_SERVICES.find((candidate) => candidate.name === "vaultwarden")!,
      env: { ROOMS: JSON.stringify({ a: ["x y", 'q"z'] }), PLAIN: "7" },
    };
    const quadlet = renderQuadlet(spec);
    expect(quadlet).toContain(String.raw`Environment=ROOMS="{\"a\":[\"x y\",\"q\\\"z\"]}"`);
    expect(quadlet).toMatch(/^Environment=PLAIN=7$/m);
  });
});

describe("a file whose body is key material", () => {
  const config: ServiceSecretFile = {
    name: "config",
    path: "/etc/secrets/app.config.yaml",
    generate: {
      signing: { bytes: 32, encoding: "hex" },
      store: { bytes: 32, encoding: "base64", protect: true },
    },
    content: (generated) => `signing: ${generated.signing}\nstore: ${generated.store}\n`,
  };

  it("reads back as its shape, with every drawn value stood in for", () => {
    // The whole file except the key material, which is what a review reads and
    // what the golden pins — the values themselves exist only on the board, and
    // a snapshot that held one would be this repository holding a secret.
    expect(secretFileShape(config)).toBe("signing: <generated>\nstore: <generated>\n");
  });

  it("lands only where the boot-time decrypt looks", () => {
    // `keel-secrets.service` opens `*.age` directly under /etc/secrets. A blob
    // anywhere else is written correctly and never decrypted, so the service
    // starts with its configuration missing while the deploy reports success.
    expect(isSecretsPath(config.path)).toBe(true);
    expect(isSecretsPath("/etc/app/config.yaml")).toBe(false);
    expect(isSecretsPath("/etc/secrets/nested/config.yaml")).toBe(false);
    expect(isSecretsPath("/etc/secrets/")).toBe(false);
  });
});

describe("the proxy's port and the public vhost", () => {
  // A name in `publicHosts` is answerable from anywhere or it is nothing: the
  // route stops guarding it by source address, so a filter that still dropped
  // :443 from the internet would leave the opt-out true one layer and false the
  // next. Derived and not declared, because the proxy's entry is committed and
  // an `ingress` line there would open a clone's 443 to the world as well.
  const proxy = EXAMPLE_SERVICES.find((spec) => spec.proxy !== undefined)!;
  const gated = EXAMPLE_SERVICES.find((spec) => subdomainOf(spec) !== null)!;

  it("leaves the proxy alone when no deployed vhost has opted out", () => {
    expect(publicProxyIngress(catalogOf(EXAMPLE_SERVICES), [])).toBeNull();
  });

  it("opens the proxy's own port to the world when one has", () => {
    const derived = publicProxyIngress(catalogOf(EXAMPLE_SERVICES), [subdomainOf(gated)!]);
    expect(derived?.name).toBe(proxy.name);
    expect(derived?.ingress?.worldTcp).toContain(proxy.port);
    // Everything the entry declared is still there.
    expect(derived?.ingress?.lanTcp).toEqual(proxy.ingress?.lanTcp);
  });

  it("names a subdomain nothing deploys as no reason to open anything", () => {
    expect(publicProxyIngress(catalogOf(EXAMPLE_SERVICES), ["nothing-deploys-this"])).toBeNull();
  });
});
