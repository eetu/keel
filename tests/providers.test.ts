import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SERVICES } from "../src/config/services";
import { secretsPath } from "../src/config/spec";
import { decide } from "../src/infra/providers/dnsRecord";
import { assertWritablePath } from "../src/infra/providers/remoteFile";
import { assertCiphertext } from "../src/infra/providers/secretFile";
import { assertSafePath, assertSafeUnit, run } from "../src/infra/ssh";
import { envLine } from "../src/infra/vault";

describe("what may be written to a device", () => {
  it("refuses a path a remote shell would re-parse", () => {
    // ssh joins its arguments and the login shell parses the result, so a path
    // with shell syntax in it would be executed rather than written.
    for (const path of ["/etc/x;reboot", "/etc/$(id)", "/etc/a b", "etc/relative", "/etc/*"]) {
      expect(() => assertSafePath(path), path).toThrow(/unsafe remote path/);
    }
    expect(() => assertSafePath("/etc/containers/systemd/app.container")).not.toThrow();
  });

  it("refuses a plain file under /etc/secrets", () => {
    // A RemoteFile carries its content as an input, and inputs are state. The
    // no-plaintext-in-state property is this check rather than a convention:
    // sealed blobs go through SecretFile, which carries ciphertext.
    expect(() => assertWritablePath("/etc/secrets/app.env")).toThrow(/SecretFile/);
    expect(() => assertWritablePath("/etc/secrets/app.env.age")).toThrow(/SecretFile/);
    expect(() => assertWritablePath("/etc/traefik/traefik.yml")).not.toThrow();
  });

  it("names the directory the catalog derives secret paths from", () => {
    // If `secretsPath` ever moved, the guard above would be watching an empty
    // directory. This is what keeps the two pointing at the same place.
    for (const spec of SERVICES.filter((candidate) => candidate.secretEnv !== undefined)) {
      expect(() => assertWritablePath(secretsPath(spec)!)).toThrow(/SecretFile/);
    }
  });

  it("refuses an empty ciphertext", () => {
    // A dependency unknown that slips through resolution arrives as "" — and an
    // empty blob written to the device becomes a service with a blank
    // environment, which is a boot-time mystery instead of a deploy-time error.
    expect(() => assertCiphertext("", "/etc/secrets/app.env.age")).toThrow(/empty ciphertext/);
    expect(() => assertCiphertext(undefined, "/etc/secrets/app.env.age")).toThrow(
      /empty ciphertext/,
    );
    expect(() => assertCiphertext("-----BEGIN AGE ENCRYPTED FILE-----", "/x")).not.toThrow();
  });
});

describe("adopting an existing Cloudflare record", () => {
  const wanted = { content: "192.0.2.10", ttl: 120 };

  it("creates when the zone has no matching record", () => {
    expect(decide([], wanted)).toEqual({ action: "create" });
  });

  it("adopts a lone match whose content and ttl already agree", () => {
    const record = { id: "rec1", ...wanted };
    expect(decide([record], wanted)).toEqual({ action: "adopt", id: "rec1" });
  });

  it("patches a lone match whose content or ttl disagree", () => {
    const record = { id: "rec1", content: "192.0.2.99", ttl: 300 };
    expect(decide([record], wanted)).toEqual({ action: "patch", id: "rec1" });
  });

  it("refuses to pick among more than one match", () => {
    const records = [
      { id: "rec1", ...wanted },
      { id: "rec2", content: "192.0.2.99", ttl: 300 },
    ];
    expect(decide(records, wanted)).toEqual({ action: "ambiguous", ids: ["rec1", "rec2"] });
  });
});

describe("dynamic resource output fields", () => {
  it("are declared with `declare`, never emitted", () => {
    // tsx compiles class fields with define semantics: a field written as
    // `public readonly x!: Output<string>` becomes a real property definition
    // that runs after super() and overwrites the Output the SDK just installed
    // with undefined — every consumer of that output then receives an empty
    // value. `declare` emits nothing, so the SDK's property survives. This
    // failed silently in production: an empty ciphertext reached a device.
    const dir = fileURLToPath(new URL("../src/infra/providers", import.meta.url));
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
      const source = readFileSync(`${dir}/${name}`, "utf8");
      expect(source, name).not.toMatch(/^\s*(?:public\s+)?readonly \w+!:/m);
    }
  });
});

describe("what the decrypted env file may contain", () => {
  it("writes the value raw — podman's env-file parser strips nothing", () => {
    // The quadlet's EnvironmentFile= becomes `podman run --env-file`, whose
    // docker-style parser takes the bytes after `=` literally. A quoted value
    // deploys with the quotes in it: an AES key two bytes too long, a password
    // no login accepts.
    expect(envLine("KEY", "abc123==")).toBe("KEY=abc123==");
    expect(envLine("KEY", 'p"q\\r')).toBe('KEY=p"q\\r');
    expect(() => envLine("KEY", "two\nlines")).toThrow(/newline/);
  });
});

describe("what may be handed to systemctl", () => {
  it("refuses a unit name a remote shell would re-parse", () => {
    // A backslash is in that set: the remote shell eats it, so systemd's own path
    // escaping arrives as `var-mnt-myx2dshare.mount` — a different unit, and one
    // that exists nowhere.
    for (const unit of [
      "app.service; reboot",
      "app",
      "app.service extra",
      "*.service",
      "var-mnt-my\\x2dshare.mount",
      "",
    ]) {
      expect(() => assertSafeUnit(unit), unit).toThrow(/unsafe unit name/);
    }
  });

  it("accepts the shapes systemd actually uses", () => {
    for (const unit of [
      "vaultwarden.service",
      "oauth2-proxy.service",
      "nftables.service",
      "keel-apps.slice",
      "mnt-media.mount",
      "bootc-fetch-apply-updates.timer",
    ]) {
      expect(() => assertSafeUnit(unit), unit).not.toThrow();
    }
  });
});

describe("what a failed ssh means", () => {
  /** An `ssh` ahead of the real one on PATH, answering every call the same way. */
  const withFakeSsh = async (stderr: string, exit: number, body: () => Promise<void>) => {
    const dir = mkdtempSync(`${tmpdir()}/keel-ssh-`);
    writeFileSync(`${dir}/ssh`, `#!/bin/sh\necho '${stderr}' >&2\nexit ${exit}\n`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = `${dir}:${previous}`;
    try {
      await body();
    } finally {
      process.env.PATH = previous;
    }
  };

  it("throws on ssh's own exit status instead of reporting the command failed", async () => {
    // 255 is ssh's and never the remote command's. Every provider's `read` asks
    // "does this exist" through the status of a probe, so a refused session read
    // as a failed probe is a live resource dropped from state on a refresh and
    // re-created on the next run — the transport has to fail by name instead.
    await withFakeSsh("Permission denied (publickey)", 255, async () => {
      await expect(run("nowhere", ["test", "-e", "/x"])).rejects.toThrow(/could not run test/);
    });
  });

  it("hands a remote command's own failure back to the caller", async () => {
    await withFakeSsh("", 1, async () => {
      await expect(run("nowhere", ["test", "-e", "/x"])).resolves.toMatchObject({ status: 1 });
    });
  });
});
