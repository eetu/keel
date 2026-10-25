/**
 * The remote program, run for real, against a stand-in Kanidm.
 *
 * The same harness as `netbirdAccount.test.ts`: a fake `ssh` on PATH pipes the
 * program to a real `python3`, and a stub server answers the calls the program
 * makes — over TLS here, with a throwaway certificate, because the program
 * speaks `https` to the server's loopback. A fake `op` keeps the vault in a
 * directory, so a test can see what was written and what was only read.
 *
 * The stub answers the way the server does where it matters: the sign-in is
 * three steps carried by a session header, a scope map names its group by UUID,
 * and a group's members come back as SPNs.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SERVICES } from "../src/config/services";
import {
  catalogOf,
  dependencyNames,
  oidcRegistrations,
  type ServiceSpec,
} from "../src/config/spec";
import {
  adminProvider,
  clientProvider,
  type KanidmAdminInputs,
  type KanidmClientInputs,
} from "../src/infra/providers/kanidmClient";

const VAULT = "fixture";
const PASSWORD = "admin-password";
const REALM = "idm.example.test";

type Seen = { method: string; path: string; session: string; type: string; body: unknown };

type Client = { attrs: Record<string, string[]>; scopeMap: Map<string, string[]>; secret: string };

type Kanidm = {
  port: number;
  seen: Seen[];
  clients: Map<string, Client>;
  groups: Map<string, { uuid: string; members: string[] }>;
  close: () => Promise<void>;
};

let tls = { key: "", cert: "" };

beforeAll(() => {
  const dir = mkdtempSync(`${tmpdir()}/keel-kanidm-tls-`);
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${dir}/key.pem`,
    "-out",
    `${dir}/cert.pem`,
    "-days",
    "1",
    "-subj",
    "/CN=idm.example.test",
  ]);
  tls = {
    key: readFileSync(`${dir}/key.pem`, "utf8"),
    cert: readFileSync(`${dir}/cert.pem`, "utf8"),
  };
});

/** URL attributes as the server keeps them: parsed, so a bare origin ends in a slash. */
function asKept(attrs: Record<string, string[]>): Record<string, string[]> {
  const urls = ["oauth2_rs_origin", "oauth2_rs_origin_landing"];
  return Object.fromEntries(
    Object.entries(attrs).map(([name, values]) => [
      name,
      urls.includes(name) ? values.map((value) => new URL(value).href) : values,
    ]),
  );
}

/** Persons the server knows, by name, with their UUIDs. */
const PERSONS: Record<string, string> = {
  eetu: "uuid-person-eetu",
  someone: "uuid-person-someone",
};

/** A Kanidm that answers the calls the program makes, and records each one. */
async function kanidm(start: {
  clients?: Record<
    string,
    { attrs: Record<string, string[]>; scopeMap?: Record<string, string[]> }
  >;
  groups?: Record<string, string[]>;
}): Promise<Kanidm> {
  const groups = new Map<string, { uuid: string; members: string[] }>([
    ["idm_all_persons", { uuid: "uuid-group-idm_all_persons", members: [] }],
  ]);
  for (const [name, members] of Object.entries(start.groups ?? {})) {
    groups.set(name, { uuid: `uuid-group-${name}`, members: members.map((m) => PERSONS[m]) });
  }
  const uuidOf = (name: string) => groups.get(name)?.uuid ?? name;
  const clients = new Map<string, Client>();
  for (const [name, client] of Object.entries(start.clients ?? {})) {
    clients.set(name, {
      attrs: client.attrs,
      scopeMap: new Map(
        Object.entries(client.scopeMap ?? {}).map(([group, scopes]) => [uuidOf(group), scopes]),
      ),
      secret: `secret-${name}`,
    });
  }
  const seen: Seen[] = [];

  const server: Server = createServer(tls, (request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += String(chunk)));
    request.on("end", () => {
      const path = request.url ?? "";
      const method = request.method ?? "";
      const body: unknown = raw === "" ? undefined : JSON.parse(raw);
      const session = String(request.headers["x-kanidm-auth-session-id"] ?? "");
      const type = String(request.headers["content-type"] ?? "");
      seen.push({ method, path, session, type, body });
      const answer = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "Content-Type": "application/json", ...headers });
        response.end(payload === undefined ? "" : JSON.stringify(payload));
      };

      if (path === "/status") return answer(200, true);
      if (path === "/v1/auth") {
        const step = (body as { step: Record<string, unknown> }).step;
        if ("init2" in step)
          return answer(
            200,
            { state: { choose: ["password"] } },
            { "X-KANIDM-AUTH-SESSION-ID": "s1" },
          );
        if ("begin" in step && session === "s1") {
          return answer(
            200,
            { state: { continue: ["password"] } },
            { "X-KANIDM-AUTH-SESSION-ID": "s2" },
          );
        }
        const given = (step.cred as { password?: string } | undefined)?.password;
        if (session === "s2" && given === PASSWORD)
          return answer(200, { state: { success: "tok" } });
        return answer(200, { state: { denied: "no" } });
      }
      if (request.headers.authorization !== "Bearer tok") return answer(401, "unauthorized");

      const parts = path.split("/").filter(Boolean);
      // /v1/person/<name>
      if (parts[1] === "person") {
        const uuid = PERSONS[parts[2]];
        return uuid ? answer(200, { attrs: { uuid: [uuid] } }) : answer(404, "nomatchingentries");
      }
      // /v1/group, /v1/group/<name>, /v1/group/<name>/_attr/member
      if (parts[1] === "group") {
        if (parts.length === 2 && method === "POST") {
          const name = (body as { attrs: { name: string[] } }).attrs.name[0];
          groups.set(name, { uuid: `uuid-group-${name}`, members: [] });
          return answer(200, null);
        }
        const group = groups.get(parts[2]);
        if (group === undefined) return answer(404, "nomatchingentries");
        if (parts.length === 3)
          return answer(200, { attrs: { uuid: [group.uuid], name: [parts[2]] } });
        if (method === "PUT") group.members = (body as string[]).map((m) => PERSONS[m] ?? m);
        if (method === "DELETE") group.members = [];
        const spn = (uuid: string) =>
          `${Object.keys(PERSONS).find((name) => PERSONS[name] === uuid) ?? uuid}@${REALM}`;
        return answer(200, method === "GET" ? group.members.map(spn) : null);
      }
      // /v1/oauth2/...
      if (parts[1] === "oauth2") {
        if (parts[2] === "_basic") {
          const attrs = asKept((body as { attrs: Record<string, string[]> }).attrs);
          clients.set(attrs.name[0], {
            attrs,
            scopeMap: new Map(),
            secret: `secret-${attrs.name[0]}`,
          });
          return answer(200, null);
        }
        const client = clients.get(parts[2]);
        if (client === undefined) return answer(404, "nomatchingentries");
        if (parts.length === 3) {
          if (method === "DELETE") {
            clients.delete(parts[2]);
            return answer(200, null);
          }
          if (method === "PATCH") {
            Object.assign(
              client.attrs,
              asKept((body as { attrs: Record<string, string[]> }).attrs),
            );
            return answer(200, null);
          }
          const scopeMap = [...client.scopeMap].map(
            ([group, scopes]) => `${group}: {${scopes.map((s) => `"${s}"`).join(", ")}}`,
          );
          return answer(200, { attrs: { ...client.attrs, oauth2_rs_scope_map: scopeMap } });
        }
        if (parts[3] === "_basic_secret") return answer(200, client.secret);
        if (parts[3] === "_scopemap") {
          const key = uuidOf(parts[4]);
          if (method === "DELETE") client.scopeMap.delete(key);
          else client.scopeMap.set(key, [...(body as string[])].sort());
          return answer(200, null);
        }
        if (parts[3] === "_attr" && method === "DELETE") {
          delete client.attrs[parts[4]];
          return answer(200, null);
        }
      }
      return answer(404, "no such path");
    });
  });

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    seen,
    clients,
    groups,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

let bin = "";
let store = "";
let path = "";

/** A field's file in the fake vault. */
const stored = (item: string, field: string) => `${store}/${VAULT}__${item}__${field}`;

/**
 * The fake `ssh`, which runs the program the way the board would and answers a
 * recovery inside the container with the JSON the server prints, and the fake
 * `op`, which keeps fields as files. `item get` fails as an unreachable vault
 * does when the store says so.
 */
beforeEach(() => {
  bin = mkdtempSync(`${tmpdir()}/keel-kanidm-`);
  store = mkdtempSync(`${tmpdir()}/keel-kanidm-vault-`);
  writeFileSync(
    `${bin}/ssh`,
    [
      "#!/bin/sh",
      'case "$*" in',
      `  *podman*) echo '{"status":"ok","output":"recovered-password"}' ;;`,
      "  *) exec python3 - ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    `${bin}/op`,
    [
      "#!/bin/sh",
      `STORE='${store}'`,
      'if [ "$1" = read ]; then',
      '  ref="${2#op://}"; file="$STORE/$(echo "$ref" | sed "s#/#__#g")"',
      '  if [ -f "$file" ]; then cat "$file"; exit 0; fi',
      `  echo "isn't a field" >&2; exit 1`,
      "fi",
      'if [ "$1 $2" = "item edit" ]; then',
      '  field="${6%%\\[*}"; value="${6#*=}"',
      '  printf "%s\\n" "$value" > "$STORE/$5__$3__$field"; exit 0',
      "fi",
      'if [ "$1 $2" = "item get" ]; then',
      '  if [ -f "$STORE/unreachable" ]; then echo "connection refused" >&2; exit 1; fi',
      '  labels=$(ls "$STORE" | sed -n "s#^$5__$3__##p" | sed \'s/.*/{"label":"&"}/\' | paste -sd, -)',
      '  echo "{\\"fields\\":[$labels]}"; exit 0',
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(stored("kanidm", "idm_admin_password"), `${PASSWORD}\n`);
  path = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${path}`;
});

afterEach(() => {
  process.env.PATH = path;
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const declared = (
  port: number,
  overrides: Partial<KanidmClientInputs> = {},
): KanidmClientInputs => ({
  host: "fixture",
  port,
  vault: VAULT,
  admin: { account: "idm_admin", item: "kanidm", field: "idm_admin_password" },
  clientId: "kb",
  displayName: "Knowledge",
  landing: "https://kb.example.test",
  redirects: ["https://kb.example.test/auth/callback", "https://kb.example.test/oauth/callback"],
  scopeMap: { kb_users: ["openid", "profile", "email", "groups"] },
  groups: { kb_users: ["eetu"], kb_admins: ["eetu"] },
  pkce: true,
  secret: { item: "kanidm", field: "kb_client_secret" },
  ...overrides,
});

describe("registering a client", () => {
  let server: Kanidm;
  afterEach(async () => server.close());

  it("signs in as the admin in three steps, the session carried between them", async () => {
    server = await kanidm({});
    await clientProvider.create!(declared(server.port));
    const auth = server.seen.filter((call) => call.path === "/v1/auth");
    expect(auth.map((call) => Object.keys((call.body as { step: object }).step)[0])).toEqual([
      "init2",
      "begin",
      "cred",
    ]);
    expect(auth.map((call) => call.session)).toEqual(["", "s1", "s2"]);
    expect((auth[0].body as { step: { init2: object } }).step.init2).toEqual({
      username: "idm_admin",
      issue: "token",
      privileged: true,
    });
  });

  it("makes the client and its groups, and writes the secret the server generated into the vault", async () => {
    server = await kanidm({});
    const made = await clientProvider.create!(declared(server.port));

    const client = server.clients.get("kb")!;
    expect(client.attrs.oauth2_rs_origin).toEqual([
      "https://kb.example.test/auth/callback",
      "https://kb.example.test/oauth/callback",
    ]);
    expect(client.attrs.oauth2_rs_origin_landing).toEqual(["https://kb.example.test/"]);
    expect(client.scopeMap.get("uuid-group-kb_users")).toEqual([
      "email",
      "groups",
      "openid",
      "profile",
    ]);
    expect(server.groups.get("kb_admins")?.members).toEqual(["uuid-person-eetu"]);
    // The secret reaches the vault field the client's entry reads, and state
    // holds only its hash.
    expect(readFileSync(stored("kanidm", "kb_client_secret"), "utf8").trim()).toBe("secret-kb");
    expect(made.outs?.secretHash).toBe(sha("secret-kb"));
    expect(JSON.stringify(made.outs)).not.toContain("secret-kb");
  });

  it("adopts a client registered by hand by adding to it, and converges it on the next update", async () => {
    server = await kanidm({
      clients: {
        kb: {
          attrs: {
            name: ["kb"],
            displayname: ["kb"],
            oauth2_rs_origin: ["https://kb.example.test/old"],
            oauth2_allow_insecure_client_disable_pkce: ["true"],
          },
          scopeMap: { idm_all_persons: ["openid"] },
        },
      },
      groups: { kb_admins: ["someone"] },
    });
    const adopted = await clientProvider.create!(declared(server.port));

    // Nothing a hand registered is taken away by the create: it may be how
    // somebody signs in, and a create has no plan line that shows it going.
    const client = server.clients.get("kb")!;
    expect(server.seen.some((call) => call.path === "/v1/oauth2/_basic")).toBe(false);
    expect(client.attrs.oauth2_rs_origin).toHaveLength(3);
    expect(client.attrs.oauth2_allow_insecure_client_disable_pkce).toEqual(["true"]);
    expect([...client.scopeMap.keys()].sort()).toEqual([
      "uuid-group-idm_all_persons",
      "uuid-group-kb_users",
    ]);
    expect(server.groups.get("kb_admins")?.members.sort()).toEqual([
      "uuid-person-eetu",
      "uuid-person-someone",
    ]);

    // What it kept is in the outputs, so the next plan shows it as an update…
    const diff = await clientProvider.diff!("kb", adopted.outs!, declared(server.port));
    expect(diff.changes).toBe(true);
    // …and the update converges to the exact set.
    await clientProvider.update!("kb", adopted.outs!, declared(server.port));
    expect(client.attrs.oauth2_rs_origin).toHaveLength(2);
    expect(client.attrs.oauth2_allow_insecure_client_disable_pkce).toBeUndefined();
    expect([...client.scopeMap.keys()]).toEqual(["uuid-group-kb_users"]);
    expect(server.groups.get("kb_admins")?.members).toEqual(["uuid-person-eetu"]);
  });

  it("sets the short username only where the declaration states it", async () => {
    server = await kanidm({});
    const made = await clientProvider.create!(declared(server.port));
    expect(server.clients.get("kb")!.attrs.oauth2_prefer_short_username).toBeUndefined();
    await clientProvider.update!("kb", made.outs!, declared(server.port, { shortUsername: true }));
    expect(server.clients.get("kb")!.attrs.oauth2_prefer_short_username).toEqual(["true"]);
  });

  it("sends a JSON content type only with a body", async () => {
    server = await kanidm({});
    await clientProvider.create!(declared(server.port));
    for (const call of server.seen) {
      expect(call.type === "application/json").toBe(call.body !== undefined);
    }
  });

  it("fails by name when the vault's admin password is not the server's, and never says it", async () => {
    server = await kanidm({});
    writeFileSync(stored("kanidm", "idm_admin_password"), "stale\n");
    const failed = clientProvider.create!(declared(server.port));
    await expect(failed).rejects.toThrow(/idm_admin was refused/);
    await expect(failed).rejects.not.toThrow(/stale/);
  });
});

describe("reading a client back", () => {
  let server: Kanidm;
  afterEach(async () => server.close());

  it("reports it in the declaration's names, whatever the server answered in", async () => {
    server = await kanidm({});
    const made = await clientProvider.create!(declared(server.port));
    const read = await clientProvider.read!("kb", made.outs!);
    expect(read.id).toBe("kb");
    const diff = await clientProvider.diff!("kb", read.props!, declared(server.port));
    expect(diff.changes).toBe(false);
  });

  it("is drift when somebody adds a redirect in the web UI", async () => {
    server = await kanidm({});
    const made = await clientProvider.create!(declared(server.port));
    server.clients.get("kb")!.attrs.oauth2_rs_origin.push("https://elsewhere.example.test/cb");
    const read = await clientProvider.read!("kb", made.outs!);
    const diff = await clientProvider.diff!("kb", read.props!, declared(server.port));
    expect(diff.changes).toBe(true);
  });

  it("is absent when the server's secret is no longer the vault's, so the next up writes it", async () => {
    server = await kanidm({});
    const made = await clientProvider.create!(declared(server.port));
    server.clients.get("kb")!.secret = "reset-on-the-server";
    expect((await clientProvider.read!("kb", made.outs!)).id).toBeUndefined();
  });
});

describe("the admin account", () => {
  const admin: KanidmAdminInputs = {
    host: "fixture",
    container: "kanidm",
    recover: ["/sbin/kanidmd", "scripting", "recover-account", "idm_admin"],
    vault: VAULT,
    item: "kanidm",
    field: "idm_admin_password",
  };

  it("leaves a password the vault already holds alone", async () => {
    await adminProvider.create!(admin);
    expect(readFileSync(stored("kanidm", "idm_admin_password"), "utf8").trim()).toBe(PASSWORD);
  });

  it("recovers the account when the vault has no password, and writes what the server printed", async () => {
    execFileSync("rm", [stored("kanidm", "idm_admin_password")]);
    await adminProvider.create!(admin);
    expect(readFileSync(stored("kanidm", "idm_admin_password"), "utf8").trim()).toBe(
      "recovered-password",
    );
  });

  it("refuses to recover when the vault cannot say the field is missing", async () => {
    // An unreachable vault reads as empty; resetting the password then would
    // leave one nobody holds.
    execFileSync("rm", [stored("kanidm", "idm_admin_password")]);
    writeFileSync(`${store}/unreachable`, "");
    await expect(adminProvider.create!(admin)).rejects.toThrow(/unreachable/);
    expect(existsSync(stored("kanidm", "idm_admin_password"))).toBe(false);
  });
});

describe("what a registration may declare", () => {
  it("refuses a scope map without openid and a redirect that is not https", async () => {
    const checked = await clientProvider.check!(
      declared(0),
      declared(0, {
        redirects: ["http://kb.example.test/auth/callback"],
        scopeMap: { kb_users: ["profile"] },
      }),
    );
    expect(checked.failures?.map((failure) => failure.reason)).toEqual([
      "http://kb.example.test/auth/callback is not an https URL",
      "kb_users's scopes leave out openid",
    ]);
  });
});

describe("the fleet's clients", () => {
  it("refuses a group two clients both declare, which they would set in turn", () => {
    const client = (name: string): ServiceSpec => ({
      ...(SERVICES.find((entry) => entry.oidcClient !== undefined) as ServiceSpec),
      name,
      subdomain: name,
      oidcClient: { redirectPaths: ["/cb"], groups: { shared: ["eetu"] } },
    });
    expect(() =>
      oidcRegistrations([client("one"), client("two")], "kanidm", "example.test"),
    ).toThrow(/two and one both declare the group shared/);
  });

  it("orders a registered client after the identity provider, whatever its auth", () => {
    const gate = SERVICES.find((entry) => entry.name === "oauth2-proxy") as ServiceSpec;
    const names = dependencyNames({ ...gate, dependsOn: undefined }, catalogOf(SERVICES));
    expect(names).toContain(catalogOf(SERVICES).identity!.spec.name);
  });

  const registrations = oidcRegistrations(SERVICES, "kanidm", "example.test");

  it("writes each secret to the field its entry reads", () => {
    // The registration writes one field and the client's sealed environment
    // reads another, and a login fails at the token exchange with nothing in the
    // deploy having complained. So every registered client's field is one its
    // own entry names.
    expect(registrations.length).toBeGreaterThan(0);
    for (const registration of registrations) {
      const spec = SERVICES.find((entry) => entry.name === registration.service) as ServiceSpec;
      const refs = Object.values(spec.secretEnv ?? {});
      expect(refs).toContainEqual(registration.secret);
    }
  });

  it("registers the gate at its callback, for every person", () => {
    const gate = registrations.find((registration) => registration.id === "oauth2-proxy")!;
    expect(gate.redirects).toEqual(["https://auth.example.test/oauth2/callback"]);
    expect(gate.scopeMap).toEqual({ idm_all_persons: ["openid", "profile", "email"] });
    expect(gate.pkce).toBe(true);
  });
});
