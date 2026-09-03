/**
 * Integration program for the device providers.
 *
 * Declares the same shape a `Service` does — a file, then a unit driven by its
 * content hash — against a throwaway host, so `RemoteFile` and `SystemdUnit` are
 * exercised through create, read, diff, update and delete with nothing real at
 * stake. `tests/integration/run.sh` drives it.
 */

import { createHash } from "node:crypto";

import * as pulumi from "@pulumi/pulumi";

import { seal } from "../../src/infra/age";
import { RemoteFile } from "../../src/infra/providers/remoteFile";
import { SecretFile } from "../../src/infra/providers/secretFile";
import { SystemdUnit } from "../../src/infra/providers/systemdUnit";

const config = new pulumi.Config();

/** ssh_config written by the harness; the alias it defines is `keel-itest`. */
const sshArgs = ["-F", config.require("sshConfig")];
const host = "keel-itest";

/** Bumped by the harness to prove an update restarts the unit. */
const marker = config.get("marker") ?? "one";

const unitBody = [
  "[Unit]",
  "Description=keel integration probe",
  "",
  "[Service]",
  "Type=oneshot",
  "RemainAfterExit=yes",
  `ExecStart=/bin/sh -c 'echo ${marker} > /run/keel-itest.marker'`,
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");

const unitFile = new RemoteFile("probe-unit", {
  host,
  sshArgs,
  path: "/etc/systemd/system/keel-itest.service",
  content: unitBody,
  mode: "644",
});

const unit = new SystemdUnit(
  "probe",
  {
    host,
    sshArgs,
    unit: "keel-itest.service",
    quadlet: false,
    trigger: createHash("sha256").update(unitBody).digest("hex"),
  },
  { dependsOn: [unitFile] },
);

// An age blob, to exercise the part that is easy to get wrong: encryption is not
// deterministic, so a provider that diffed on ciphertext would rewrite the secret
// and restart the service on every single deploy.
const sealed = await seal(config.require("secretPlaintext"), config.require("ageRecipient"));

new SecretFile("probe-secret", {
  host,
  sshArgs,
  path: "/etc/secrets/keel-itest.env.age",
  ...sealed,
});

export const active = unit.active;
export const enabled = unit.enabled;
