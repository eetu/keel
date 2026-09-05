/**
 * Print one catalog entry as it resolves — every body a deploy would write for
 * it, and every value it would be handed.
 *
 *   yarn spec <name> [--profile 1g|4g|8g]
 *
 * This is what keeps a stamped entry readable. Six lines in a catalog are only
 * an improvement if the thirty they stand for can be seen on demand, and seen
 * through the same functions the deploy layer uses rather than a summary that
 * could describe something else: the quadlet, the route, the caps and the ports
 * printed here are the files themselves.
 *
 * Secret *values* are absent by construction — the vault is never opened, so
 * what a secret variable prints is the item and field it will be read from. The
 * installation is the real one, because the resolved entry is the point; the
 * zone in the output is the zone the entry deploys into.
 */

import process from "node:process";

import { INSTALLATION } from "../config/installation";
import { PROFILES, resolveMemory } from "../config/profiles";
import { REMOTES, SERVICES } from "../config/services";
import {
  backupPath,
  catalogOf,
  deployedAccountEmail,
  metricsSecretsPath,
  runSetup,
  secretFields,
  secretFileShape,
  secretsPath,
  serviceOrigin,
  subdomainOf,
} from "../config/spec";
import { memoryDropInPath, serviceDropIn } from "../render/memory";
import { NFT_SERVICES_PATH, renderNftPorts } from "../render/nftPorts";
import { quadletPath, renderQuadlet } from "../render/quadlet";

const usage = "usage: yarn spec <name> [--profile 1g|4g|8g]";

const args = process.argv.slice(2);
let name: string | undefined;
let profileName: string | undefined;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--profile") {
    profileName = args[i + 1];
    if (profileName === undefined) {
      console.error(usage);
      process.exit(2);
    }
    i += 1;
    continue;
  }
  if (name === undefined) {
    name = arg;
    continue;
  }
  console.error(`unexpected argument '${arg}' — ${usage}`);
  process.exit(2);
}

const spec = SERVICES.find((candidate) => candidate.name === name);
if (spec === undefined) {
  console.error(
    `${name === undefined ? usage : `no catalog entry named '${name}'`}\n` +
      `known: ${SERVICES.map((candidate) => candidate.name).join(", ")}`,
  );
  process.exit(2);
}

// The tightest case by default, which is what an unrecognised board also gets:
// caps are the one part of an entry that depends on which machine it lands on,
// and the smallest profile is the one a number has to be right for.
const profile =
  profileName === undefined ? PROFILES[0] : PROFILES.find((p) => p.name === profileName);
if (profile === undefined) {
  console.error(
    `no profile named '${profileName}' — known: ${PROFILES.map((p) => p.name).join(", ")}`,
  );
  process.exit(2);
}

const { domain } = INSTALLATION.network;
const catalog = catalogOf(SERVICES, REMOTES);
const setup = runSetup(spec, INSTALLATION, catalog);
const subdomain = subdomainOf(spec);

// Rendered before anything is printed, so a variable claimed by both halves of
// an entry fails here with the renderer's own message rather than appearing
// twice in the output.
const quadlet = renderQuadlet(spec, setup?.env, catalog);
const route = catalog.proxy?.role.route(spec, {
  domain,
  publicHosts: INSTALLATION.publicHosts,
  gate: catalog.gate,
});
const ports = renderNftPorts(spec);

const resolved = {
  name: spec.name,
  description: spec.description,
  image: spec.image,
  port: spec.port,
  auth: spec.auth,
  egress: spec.egress ?? "internal",
  vhost: subdomain === null ? null : serviceOrigin(spec, domain),
  publicDns: spec.publicDns === true,
  // The whole environment the container is handed, in the order the quadlet
  // writes it: what the entry states, then what its setup composed.
  environment: { ...spec.env, ...setup?.env },
  secrets: {
    path: secretsPath(spec),
    // Names, never values: `item/field`, which is what a person creates in the
    // vault and what the deploy reads at seal time.
    fields: Object.fromEntries(
      Object.entries(secretFields(spec)).map(([variable, { item, field }]) => [
        variable,
        `${item}/${field}`,
      ]),
    ),
  },
  // An account the deploy creates on another service rather than reads: what is
  // printable about it is the address, the role and where it lands, because the
  // password does not exist until the resource runs and is sealed in the same
  // call that makes it.
  metricsAccount:
    spec.metricsAccount === undefined
      ? null
      : {
          hub: catalog.metrics?.spec.name ?? null,
          email: deployedAccountEmail(spec, domain),
          role: spec.metricsAccount.role,
          path: metricsSecretsPath(spec),
          variables: [spec.metricsAccount.env.user, spec.metricsAccount.env.password],
        },
  // The first account the deploy claims on this service, and the identity
  // provider its own broker federates to. Printable: the address it is claimed
  // under, where a hand-minted token is read from instead, and the issuer the
  // connector is registered against — never the token, which exists only once
  // the resource has run and is a secret output of it.
  bootstrapAccount:
    spec.bootstrapAccount === undefined
      ? null
      : {
          email: deployedAccountEmail(spec, domain),
          owner: spec.bootstrapAccount.name,
          tokenDays: spec.bootstrapAccount.tokenDays,
          token: `${spec.bootstrapAccount.token.item}/${spec.bootstrapAccount.token.field}`,
          connector:
            spec.bootstrapAccount.connector === undefined || catalog.identity === undefined
              ? null
              : {
                  name: spec.bootstrapAccount.connector.name,
                  clientId: spec.bootstrapAccount.connector.clientId,
                  issuer: catalog.identity.role.issuer(
                    serviceOrigin(catalog.identity.spec, domain),
                    spec.bootstrapAccount.connector.clientId,
                  ),
                  secret:
                    `${spec.bootstrapAccount.connector.secret.item}/` +
                    spec.bootstrapAccount.connector.secret.field,
                },
        },
  // The state the deploy holds behind this service's own API rather than on the
  // board — the overlay's settings, its groups, the keys devices enrol with, the
  // networks the routing peer carries and the DNS those peers use. Printable
  // whole: it is composed from the installation and holds no credential, and
  // the one value that is a secret — a setup key's plaintext — is minted by the
  // coordinator inside the resource and never appears here.
  mesh: setup?.mesh ?? null,
  mounts: spec.mounts ?? [],
  backupPath: backupPath(spec),
  backupExclude: spec.backupExclude ?? [],
  files: (setup?.files ?? []).map((file) => ({
    name: file.name,
    path: file.path,
    mode: file.mode ?? "644",
    restarts: file.restarts !== false,
  })),
  // A file whose body is key material, printed with every value stood in for:
  // the shape is the reviewable part, and the values do not exist until a deploy
  // draws them — so what is printable is where the file lands, what it asks for,
  // and every line of it that is not a secret.
  secretFiles: (setup?.secretFiles ?? []).map((file) => ({
    name: file.name,
    path: file.path,
    generates: Object.fromEntries(
      Object.entries(file.generate).map(([name, shape]) => [
        name,
        `${shape.bytes} bytes as ${shape.encoding}${shape.protect === true ? ", protected" : ""}`,
      ]),
    ),
    body: secretFileShape(file),
  })),
  quadlet: { path: quadletPath(spec), body: quadlet },
  route:
    route === null || route === undefined
      ? null
      : { path: catalog.proxy!.role.routePath(spec), body: route },
  memory: {
    profile: profile.name,
    ...resolveMemory(spec.name, profile),
    path: memoryDropInPath(spec.name),
    body: serviceDropIn(spec.name, profile),
  },
  // This entry's share of a file the whole deployed set is written into — the
  // path is the host's, the body is this one's contribution to it.
  ports: ports === null ? null : { path: NFT_SERVICES_PATH, body: ports },
  dependsOn: spec.dependsOn ?? [],
};

process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
