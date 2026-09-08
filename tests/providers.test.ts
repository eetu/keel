import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SERVICES } from "../src/config/services";
import { secretsPath } from "../src/config/spec";
import { assertWritablePath } from "../src/infra/providers/remoteFile";
import { assertCiphertext } from "../src/infra/providers/secretFile";
import { type SystemdUnitInputs, systemdUnitProvider } from "../src/infra/providers/systemdUnit";
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

describe("a unit whose steady state is inactive", () => {
  /**
   * An `ssh` ahead of the real one that answers everything with success and
   * records what it was handed, so what the provider *runs* is the assertion. A
   * `load` unit is defined by the command that is absent from that list.
   */
  const withRecordingSsh = async (body: (calls: () => readonly string[]) => Promise<void>) => {
    const dir = mkdtempSync(`${tmpdir()}/keel-ssh-`);
    const log = `${dir}/calls`;
    writeFileSync(`${dir}/ssh`, `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = `${dir}:${previous}`;
    try {
      await body(() => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []));
    } finally {
      process.env.PATH = previous;
    }
  };

  /** A timer-triggered one-shot, as inputs. Nothing from the catalog. */
  const job: SystemdUnitInputs = {
    host: "nowhere",
    unit: "job.service",
    quadlet: true,
    action: "load",
    trigger: "abc",
  };

  it("is loaded and never started", async () => {
    // A deploy is not a reason to run a job. Without this, writing the entry
    // would fetch the forecast, run the scan or send the POST — and so would
    // every later `up` that touched the trigger.
    await withRecordingSsh(async (calls) => {
      await systemdUnitProvider.create(job);
      const argv = calls().join("\n");
      expect(argv).toContain("systemctl daemon-reload");
      expect(argv).not.toContain("systemctl start");
      expect(argv).not.toContain("systemctl restart");
      expect(argv).not.toContain("systemctl enable");
    });
  });

  it("is still loaded and not started when its trigger changes", async () => {
    // The new quadlet body reaches the next run through the manager, which is
    // what a reload is. Restarting would be running the job to tell it so.
    await withRecordingSsh(async (calls) => {
      await systemdUnitProvider.update!(
        "nowhere:job.service",
        { ...job, active: "inactive", enabled: "generated" },
        { ...job, trigger: "def" },
      );
      const argv = calls().join("\n");
      expect(argv).toContain("systemctl daemon-reload");
      expect(argv).not.toContain("systemctl restart");
    });
  });

  it("is read back as existing rather than as gone", async () => {
    // `read` asks `systemctl cat`, which answers whether the manager knows the
    // unit — never whether it is running. A read that took inactive for gone
    // would drop a live resource from state on every refresh and re-create it on
    // the next `up`, which for a one-shot is a run nobody asked for.
    await withRecordingSsh(async () => {
      const found = await systemdUnitProvider.read!("nowhere:job.service", {
        ...job,
        active: "inactive",
        enabled: "generated",
      });
      expect(found.id).toBe("nowhere:job.service");
    });
  });

  it("does not read a finished run as drift, while a stopped service still is", async () => {
    const inactive = { ...job, active: "inactive", enabled: "generated" };
    expect((await systemdUnitProvider.diff!("id", inactive, job)).changes).toBe(false);
    // The same reading for a unit that is meant to be running: a service that
    // died is work for `up` to do rather than drift the plan ignores.
    const service = { ...job, action: undefined };
    expect(
      (await systemdUnitProvider.diff!("id", { ...inactive, action: undefined }, service)).changes,
    ).toBe(true);
  });

  it("is stopped when the declaration goes away", async () => {
    // Stopping an inactive one-shot is a no-op, and stopping one that is mid-run
    // is the point: a retired job has no business finishing against a quadlet
    // file being deleted underneath it.
    await withRecordingSsh(async (calls) => {
      await systemdUnitProvider.delete!("nowhere:job.service", {
        ...job,
        active: "inactive",
        enabled: "generated",
      });
      expect(calls().join("\n")).toContain("systemctl stop job.service");
    });
  });
});
