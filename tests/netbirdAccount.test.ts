/**
 * The remote program, run for real.
 *
 * What a deploy sends the board is a Python program on stdin, and nothing about
 * it typechecks: a wrong key, a status code read off the wrong exception, a
 * branch that mints where it should adopt — all of it is a runtime fact of a
 * machine nobody is watching, discovered as an account that already exists and a
 * token that was shown once and lost. So these tests are the strings themselves.
 *
 * The transport is the real one. A fake `ssh` on PATH pipes the program to a
 * real `python3`, and a stub HTTP server stands in for the coordinator — so what
 * runs is `speak`'s own payload encoding, the preamble, and the body under test,
 * against an API that answers with status codes. A fake `op` stands in for the
 * vault, because a provider that read the real one would be a Touch ID prompt in
 * a test suite.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type BootstrapApi } from "../src/config/spec";
import {
  accountProvider,
  type BootstrapAccountInputs,
  connectorProvider,
} from "../src/infra/providers/netbirdAccount";

/** The dialect the entry declares, which is the one thing the provider does not know. */
const API: BootstrapApi = {
  instance: "/api/instance",
  requiredKey: "setup_required",
  setup: "/api/setup",
  accounts: "/api/accounts",
  connectors: "/api/identity-providers",
  authScheme: "Token",
};

const VAULT = "fixture";
const TOKEN_REF = { item: "coordinator", field: "pat" };
const SECRET_REF = { item: "issuer", field: "client_secret" };

type Seen = { method: string; path: string; auth: string; body: Record<string, unknown> };

type Coordinator = {
  url: string;
  seen: Seen[];
  close: () => Promise<void>;
};

/**
 * A coordinator that answers the five calls this provider makes, and records
 * every one of them.
 *
 * `claimed` moves on a successful setup call, the way the real one does: the
 * endpoint is inert afterwards, which is the whole reason the provider checks
 * before it posts.
 */
async function coordinator(start: {
  claimed: boolean;
  mints?: string;
  live?: string[];
  connectors?: Record<string, unknown>[];
}): Promise<Coordinator> {
  let claimed = start.claimed;
  const live = new Set(start.live ?? []);
  const connectors = [...(start.connectors ?? [])];
  const seen: Seen[] = [];

  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += String(chunk)));
    request.on("end", () => {
      const path = request.url ?? "";
      const auth = request.headers.authorization ?? "";
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      seen.push({ method: request.method ?? "", path, auth, body });

      const answer = (status: number, payload: unknown): void => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      // Every path but the first two is behind a token the coordinator knows.
      const authorised = live.has(auth.replace(/^Token /, ""));

      if (path === API.instance) return answer(200, { setup_required: !claimed });
      if (path === API.setup) {
        if (claimed) return answer(400, { message: "setup already completed" });
        claimed = true;
        if (start.mints !== undefined) live.add(start.mints);
        return answer(200, {
          personal_access_token: start.mints ?? "",
          user_id: "user-1",
          account_id: "acct-1",
        });
      }
      if (!authorised) return answer(401, { message: "no" });
      if (path === API.accounts) return answer(200, [{ id: "acct-1" }]);
      if (path === API.connectors && request.method === "GET") return answer(200, connectors);
      if (path === API.connectors) {
        const made = { id: "conn-1", ...body };
        connectors.push(made);
        return answer(200, made);
      }
      if (path.startsWith(`${API.connectors}/`)) {
        const id = path.slice(API.connectors.length + 1);
        const index = connectors.findIndex((entry) => entry.id === id);
        if (index !== -1) connectors[index] = { ...connectors[index], ...body };
        return answer(200, connectors[index] ?? {});
      }
      return answer(404, { message: "no such path" });
    });
  });

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

let bin = "";
let path = "";

/**
 * The fake `ssh` and the fake `op`.
 *
 * `ssh` ignores the alias and the `sudo` the caller inserts and execs the same
 * `python3 -` the board would, so the program reaching the interpreter is the
 * one `speak` composed, base64 payload and all.
 *
 * `op` answers only the references a test declares. Anything else answers with a
 * phrase `readField` treats as definite, because a phrase it does not would be
 * retried with a backoff measured in seconds.
 */
function withVault(fields: Record<string, string>): void {
  const cases = Object.entries(fields)
    .map(([reference, value]) => `  ${reference}) printf '%s\\n' '${value}' ;;`)
    .join("\n");
  writeFileSync(
    `${bin}/op`,
    `#!/bin/sh\ncase "$2" in\n${cases}\n  *) echo "isn't a field" >&2; exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
}

beforeEach(() => {
  bin = mkdtempSync(`${tmpdir()}/keel-coordinator-`);
  writeFileSync(`${bin}/ssh`, "#!/bin/sh\nexec python3 -\n", { mode: 0o755 });
  withVault({});
  path = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${path}`;
});

afterEach(() => {
  process.env.PATH = path;
});

const inputs = (url: string): BootstrapAccountInputs => ({
  host: "fixture",
  apiUrl: url,
  api: API,
  email: "coordinator@example.test",
  name: "Bootstrap Owner",
  tokenDays: 365,
  vault: VAULT,
  token: TOKEN_REF,
});

const reference = (of: { item: string; field: string }) => `op://${VAULT}/${of.item}/${of.field}`;

describe("claiming the first account", () => {
  let mesh: Coordinator;
  afterEach(async () => mesh.close());

  it("mints one against an unclaimed coordinator, and generates the owner's password", async () => {
    // The path a fresh board takes, and the only one that ever produces a token:
    // the endpoint answers once and is inert afterwards. The password is drawn
    // here rather than read from anywhere, and it is kept because it is the only
    // way back into the account when the token reaches its cap.
    mesh = await coordinator({ claimed: false, mints: "minted-token" });
    const made = await accountProvider.create!(inputs(mesh.url));
    const outs = made.outs!;

    expect(outs.accessToken).toBe("minted-token");
    expect(outs.accountId).toBe("acct-1");
    expect(made.id).toBe("acct-1");
    expect(outs.ownerPassword).toHaveLength(43);

    const setup = mesh.seen.find((call) => call.path === API.setup)!;
    expect(setup.method).toBe("POST");
    expect(setup.body).toMatchObject({
      email: "coordinator@example.test",
      name: "Bootstrap Owner",
      create_pat: true,
      pat_expire_in: 365,
    });
    // The password reaches the coordinator and nothing else: not an argument, not
    // a file on the board, and not this test's idea of what it should be.
    expect(setup.body.password).toBe(outs.ownerPassword);
  });

  it("adopts the account a pasted token belongs to, and posts no setup call", async () => {
    // The manual path, and it wins wherever it is available: a coordinator whose
    // account somebody else created cannot be claimed, and a token pasted into
    // the vault is the only thing that can speak for it. Nothing is minted and no
    // password is drawn, because there is no local account this made.
    mesh = await coordinator({ claimed: true, live: ["pasted-token"] });
    withVault({ [reference(TOKEN_REF)]: "pasted-token" });

    const outs = (await accountProvider.create!(inputs(mesh.url))).outs!;
    expect(outs.accessToken).toBe("pasted-token");
    expect(outs.ownerPassword).toBe("");
    expect(outs.accountId).toBe("acct-1");
    expect(mesh.seen.some((call) => call.path === API.setup)).toBe(false);
  });

  it("fails by naming the field to paste a token into when there is neither", async () => {
    // The one place a `create` cannot converge: the account is there, the token
    // it answered with was shown once, and no call mints a second. So the error
    // is the recovery, and it names the item and the field a person writes to.
    mesh = await coordinator({ claimed: true });
    await expect(accountProvider.create!(inputs(mesh.url))).rejects.toThrow(
      /already claimed.*'coordinator'.*'pat'/s,
    );
    expect(mesh.seen.some((call) => call.path === API.setup)).toBe(false);
  });

  it("reports a dead token as gone rather than minting on a refresh", async () => {
    // A refresh asks whether the account is still there and the token still opens
    // it, and answers with the id or with nothing. Nothing sends the next `up`
    // into `create`, which is where the message above lives — and re-minting here
    // would be a fresh credential on every refresh, for no change at all.
    mesh = await coordinator({ claimed: true, live: ["current"] });
    const stored = {
      ...inputs(mesh.url),
      accessToken: "revoked",
      ownerPassword: "",
      accountId: "acct-1",
    };

    expect(await accountProvider.read!("acct-1", stored)).toEqual({ id: undefined });
    expect(await accountProvider.read!("acct-1", { ...stored, accessToken: "current" })).toEqual({
      id: "acct-1",
      props: { ...stored, accessToken: "current" },
    });
  });

  it("reports a wiped store as gone, whatever the token says", async () => {
    // A store restored from before the account existed answers every call the way
    // a fresh board does. The token in state may even still parse; there is no
    // account behind it.
    mesh = await coordinator({ claimed: false, live: ["current"] });
    const stored = {
      ...inputs(mesh.url),
      accessToken: "current",
      ownerPassword: "",
      accountId: "acct-1",
    };
    expect(await accountProvider.read!("acct-1", stored)).toEqual({ id: undefined });
  });
});

describe("federating to the identity provider", () => {
  let mesh: Coordinator;
  afterEach(async () => mesh.close());

  const connector = (url: string) => ({
    host: "fixture",
    apiUrl: url,
    api: API,
    accessToken: "current",
    name: "Kanidm",
    clientId: "coordinator",
    issuer: "https://idm.example.test/oauth2/openid/coordinator",
    vault: VAULT,
    secret: SECRET_REF,
  });

  it("registers one that is absent and corrects one that is there", async () => {
    // Matched by name and never by id, and corrected with a PUT on the id that is
    // already registered — the connector's id is half of every federated
    // identity's subject, so registering a second one would give every person who
    // has signed in an account the coordinator has never seen.
    mesh = await coordinator({ claimed: true, live: ["current"] });
    withVault({ [reference(SECRET_REF)]: "client-secret" });

    const made = await connectorProvider.create!(connector(mesh.url));
    expect(made.id).toBe("conn-1");
    const posted = mesh.seen.find(
      (call) => call.method === "POST" && call.path === API.connectors,
    )!;
    expect(posted.body).toEqual({
      type: "oidc",
      name: "Kanidm",
      issuer: "https://idm.example.test/oauth2/openid/coordinator",
      client_id: "coordinator",
      client_secret: "client-secret",
    });

    const again = await connectorProvider.create!(connector(mesh.url));
    expect(again.id).toBe("conn-1");
    expect(
      mesh.seen.filter((call) => call.method === "POST" && call.path === API.connectors),
    ).toHaveLength(1);
    expect(mesh.seen.some((call) => call.method === "PUT")).toBe(true);
  });

  it("reports a rotated client secret as gone, because the API never shows one", async () => {
    // The only way a rotation at the identity provider can be noticed: what is
    // registered cannot be read back, so the hash this wrote down is the whole
    // comparison. Reported absent, the next `up` re-registers with the value that
    // is current — a PUT on the same id, so no subject moves.
    mesh = await coordinator({
      claimed: true,
      live: ["current"],
      connectors: [{ id: "conn-1", name: "Kanidm" }],
    });
    withVault({ [reference(SECRET_REF)]: "client-secret" });
    const stored = (await connectorProvider.create!(connector(mesh.url))).outs!;

    expect(await connectorProvider.read!("conn-1", stored)).toEqual({
      id: "conn-1",
      props: stored,
    });
    withVault({ [reference(SECRET_REF)]: "rotated" });
    expect(await connectorProvider.read!("conn-1", stored)).toEqual({ id: undefined });
  });

  it("fails by naming the client a person has to register", async () => {
    // The identity provider generates a client's secret and it cannot be set from
    // outside, so this field is written once by hand — the same shape the gate's
    // own secret has, and the same failure when it is not there yet.
    mesh = await coordinator({ claimed: true, live: ["current"] });
    await expect(connectorProvider.create!(connector(mesh.url))).rejects.toThrow(
      /issuer\/client_secret is empty or unreadable.*'coordinator'/s,
    );
  });
});
