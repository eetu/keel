# keel

The core OS image for a Raspberry Pi fleet, plus a Pulumi layer for the state an
image cannot hold. Successor to the pyinfra repo at `../raspi`, which stays live
until a host is migrated.

The division of labour is the whole design:

- **The image owns the machine.** Packages, hardening, packet filter, podman
  networks, the memory profiles, and native unbound — the one resolver that
  ships as a package rather than a quadlet, so a host boots with a working
  recursive resolver and Pulumi entirely absent. Built as a bootable container
  (`bootc`), pushed to a registry, applied with `bootc switch`. `/usr` is
  read-only, so OS drift cannot happen.
- **Pulumi owns the workloads and the API state.** Every container service on
  the device — pihole, traefik, kanidm and oauth2-proxy included, alongside the
  app services — as quadlets it writes and manages, plus their Traefik routes,
  their memory caps, the ports the packet filter admits to them, their encrypted
  secret blobs, their public Cloudflare DNS records, and the mesh — its
  coordinator's first account, the identity provider it federates to, and the
  groups, enrolment keys, routes and DNS behind its API — with Kanidm OAuth2
  clients, the restic repository and each host's booted image digest still to
  come as those providers land.

The line between them is change frequency. An app service changes weekly and
`pulumi up` applies it in seconds; the machine changes rarely and costs a reboot.

## What owns a running service

`src/infra/providers/` holds the dynamic providers, and everything on a device is
built from them:

- **`RemoteFile`** — a file, with a `read` that returns the actual remote content
  and mode. This is the piece `@pulumi/command` cannot provide: `remote.Command`
  implements no read at all, so there is nothing for a refresh to ask and drift is
  undetectable however you invoke it. It refuses a path under `/etc/secrets`:
  content is a resource input, so a plain file there would be a plaintext secret
  in state.
- **`SecretFile`** — an age blob, diffed on the plaintext's hash because age is
  not deterministic.
- **`SystemdUnit`** — a unit's runtime state. Its `delete` stops and disables the
  unit, which is where the old repo's 29 hand-written cleanup branches went. Its
  `trigger` input is a hash of whatever should cause a restart, replacing the
  `.*-stamp` files and the shell that compared them. `action: "reload"` marks a
  unit the image owns and Pulumi only reconfigures — `nftables.service` — whose
  delete leaves it running.
- **`ImageDigest`** and **`SealedEnv`** exist so that neither a registry
  round-trip nor a Touch ID prompt is the price of asking what would change.
  Resolving a rolling tag is a registry round-trip and reading the vault is a
  Touch ID prompt; in the program body both would fire on every `pulumi preview`.
  Inside a resource they fire on `create`, `update` and `read` — on `up` and on
  `refresh`, never on a preview.

`Service` (`src/infra/service.ts`) composes them: one `ServiceSpec` becomes a
quadlet, a memory drop-in, a unit, a route file, and — as that provider lands —
an OIDC client. Its public DNS record is a resource of its own beside it, in
`src/infra/index.ts` rather than inside `Service`, one per `publicDns: true`
vhost — see below. The ports it asks the packet filter for go into one file the
program writes for the whole host; see the trap about the merge.

**Why quadlets and not `@pulumi/docker` against the podman socket.** The Docker
API has no `EnvironmentFile`, so environment would have to be passed inline and
every secret value would land in Pulumi state. Quadlets also keep systemd's
slices, sandboxing and `After=<mount>` ordering, none of which the container API
models.

**Why Traefik.** Not for the label discovery — that is unused here. The bar a
replacement has to clear is: wildcard `*.domain` over Cloudflare **DNS-01** (port
80 is never exposed for a challenge), an IP allowlist on every route by default,
forward-auth to oauth2-proxy, `h2c` upstreams for netbird's gRPC plus a priority
catch-all for its dashboard, hot-reload from a watched directory, and a 64M cap.
Caddy is the only serious alternative and clears all of it, but its Cloudflare DNS
module needs an `xcaddy` custom build, and its admin API — the one genuinely
better thing, since it would make routes resources with a real `read` instead of
files — puts the proxy's live truth outside the image. Revisit it as a contained
swap once the fleet is migrated, not as a variable inside the migration. nginx
has no ACME, HAProxy needs the separate Data Plane API daemon for DNS-01, Envoy is
an xDS control plane for 25 vhosts, and Pomerium would have to fit where traefik
and oauth2-proxy fit today.

**Why route files and not container labels.** Label discovery needs Traefik to
read the rootful podman socket, and that socket's API is unrestricted — a client
can create a `--privileged` container bind-mounting `/`, so socket access is root
access and a dedicated user only renames it. Pulumi is writing a quadlet per
service anyway, so a route file beside it costs nothing and keeps `internal-only`
applied in code with a test behind it.

## Runtime: ESM, tsx, `runtime: nodejs`

Two separate problems live here, with two separate fixes. Both are load-bearing,
and neither is obvious from the code alone.

**1. Resolution.** Pulumi's bundled ts-node delegates module resolution to Node
in ESM mode, which rejects extensionless relative imports. So **tsx** loads the
program instead: `typescript: false` in `Pulumi.yaml` plus that same file's
`nodeargs: "--import tsx"`, which is how the CLI hands the flag to node — so
nothing about the loader lives in anyone's shell. tsx resolves the way a
bundler does, so the repo keeps the same import style as the rest of the fleet.

**2. Serialisation.** Pulumi serialises a dynamic provider's methods into state,
and its serialiser turns a captured value into a `require` call only when it can
resolve that value back to a module. `require('fs')` resolves; `require('fs').readFile`
does not — and an ESM named import looks exactly like the second case. It then
walks the function object into node internals and fails with _"could not be
serialized because it was a native code function"_
([pulumi/pulumi#6987](https://github.com/pulumi/pulumi/issues/6987),
[#18977](https://github.com/pulumi/pulumi/issues/18977), open).

**So `src/infra/ssh.ts` imports nothing at module scope**, and pulls
`node:child_process` in with `await import()` inside the function. That looks like
a style quirk and is not — a top-level import there breaks every provider. The
same rule applies to any new provider module.

Three consequences worth knowing:

- A dynamic provider must never **capture** a secret: serialisation would write it
  to state in plaintext ([#8265](https://github.com/pulumi/pulumi/issues/8265)).
  Secrets reach a device as age ciphertext referenced by path, so this holds by
  construction — keep it that way.
- **A dynamic resource's output fields must use `declare`**, never
  `public readonly x!: pulumi.Output<string>`. tsx compiles class fields with
  define semantics, so the `!` form becomes a real property definition that runs
  after `super()` and overwrites the Output the SDK just installed with
  `undefined` — every consumer of that output then silently receives an empty
  value, while the engine's checkpoint holds the real one. A test in
  `tests/providers.test.ts` rejects the emitting form.
- **`runtime: bun`** would give native TypeScript and no loader config, but Pulumi
  documents `pulumi.dynamic.Resource` as unsupported under it. Dynamic providers
  are also reported not to work under pnpm; this repo is on vendored yarn.

## Commands

```fish
node .yarn/releases/yarn-4.18.0.cjs install  # what a `yarn` on PATH delegates to
yarn validate                 # typecheck + lint + format + tests — run before landing
CI=true yarn test             # the same tests, refusing to write a snapshot it has not seen
yarn render                   # config -> build/root/
yarn spec <name>              # one entry as it resolves — quadlet, route, caps, secret fields
yarn card-config <host>       # keel.conf for one board in installation.ts
yarn test:integration         # tier 3: the device providers against a booted image
image/build.sh [tag]          # render + podman build --arch arm64 (default keel:latest)
image/test.sh [tag]           # tier 2: bootc lint, unit syntax, generator profiles
image/card.sh <host>          # build, shrink, add the Pi firmware and keel.conf, boot-test
yarn preview -s <host>        # pulumi preview --refresh, vault- and .env-loaded
yarn deploy -s <host>         # pulumi up --refresh, vault- and .env-loaded
```

The last two go through `scripts/pulumi.ts`, which warms the 1Password session,
reads the Cloudflare token into `CLOUDFLARE_API_TOKEN` and loads `.env` before it
spawns the vendored CLI — so both want a terminal 1Password can prompt, a
preview included. `yarn pulumi <args>` is the CLI with `.env` and nothing else.

A fresh clone wants `installation.example.ts` and `services.local.example.ts`
copied over their real names first; everything above needs the two present on
disk before it will run.

## Rules that matter

**Render, never hand-author.** `src/render/*` are pure functions from config to a
`Tree` (path -> content + mode). No `fs`, no network, no `process`. `src/cli/`
is the only place that writes to disk. This is what lets the invariant tests run
in milliseconds, and it is the property to protect when adding a renderer.

**One image, no hosts.** `renderAll()` takes no argument and every board boots
the same artefact. What makes one of them a particular machine arrives after the
build: `keel.conf` on the ESP carries the boot identity — hostname, admin keys,
the LAN and mesh ranges — and Pulumi carries the services. So `src/render/*`
imports only `keel.ts`, `profiles.ts`, `services.ts`, `versions.ts` and
`types.ts`; a renderer that read `installation.ts` would put one installation
into an artefact meant for all of them, and a test asserts it does not — over
`src/config/*` as well, since the renderers read the catalog. An entry is handed
the installation, never reaching for it. `INSTALLATION.hosts` still says what
each board runs: that is the Pulumi layer's selection, not an image variant.

`profiles.ts` reading the catalog is why a render needs `services.local.ts` on
disk even though nothing about a service is in the tree: the slice budgets are
the sum of the core tier's caps. So `yarn render` on a fresh clone wants the
local catalog's example copied into place, which is what CI does before
`image/build.sh`.

That makes the local catalog the one piece of installation config a renderer's
import graph reaches — the scan forbids `config/installation`, and cannot forbid
the catalog the renderers read. What keeps the tree independent of
it is arithmetic instead: `tests/catalog.test.ts` prices the core tier's budgets
from the example catalog alone, so a local entry claiming that tier fails
`yarn validate` rather than quietly changing the artefact CI builds. Keep that
test in mind before moving anything into the core tier.

**Adding a service is one entry in a catalog.** The quadlet, the unit, the memory
drop-in, the firewall rule, the router and the DNS name all derive from it. Its
`memory` block is its cap; its `setup(installation)` is the whole
installation-shaped half — the env that names the zone, the files whose content
does. There is nothing to register, no table to add a name to and no dispatch to
extend. If configuring a service needs an edit anywhere else, the config shape is
wrong, and a test refuses the shape that would let it: no module outside the
catalog may name two services or branch on one's name.

**Which catalog is the whole question of what this repository is.**
`src/config/services.ts` holds the committed example — traefik, kanidm,
oauth2-proxy, pihole, vaultwarden — and that set _is_ keel: LAN DNS with ad
blocking, a wildcard certificate over DNS-01, SSO in front of everything, and a
password manager. A stranger clones this and gets those. Everything one house
runs on top of them belongs in the gitignored `src/config/services.local.ts`,
whose committed twin `services.local.example.ts` is what a clone copies into
place. **Never put an installation's own service in the example catalog** — it
would publish what that house runs and be wrong for everybody else — and never
commit the local one. `SERVICES` is `composeCatalog(EXAMPLE_SERVICES,
LOCAL_SERVICES)`; every consumer iterates that and nothing downstream knows the
difference. Two guards hold the line: a committed entry may name no address but
loopback and the wildcard, nothing from the installation object and no moving tag
(`tests/catalog.test.ts`), and a local entry stays in the `apps` tier, because
the image's slice budgets are the sum of the core tier's caps and a local entry
there would change the artefact CI builds.

**`Installation` holds what the fleet or several services need** — the network,
the mesh, the domain, the vault's name, the backup target, the shares, the mail
relay. **What one service needs lives in that service's entry**: composed from a
parameter of its `setup` where the entry is committed and may name no house, and
stated outright where the entry is in the gitignored local catalog, which is one
installation's configuration already. A field with exactly one reader, and that
reader a local entry, is the mistake — it sends one service's value the long way
round through the type the whole fleet shares, and a catalog of twenty services
would put twenty fields on `Installation` that every clone has to fill in and
none of them can use. `smtp` is not that shape: its reader is committed, and a
stranger's relay is a different host, port and security mode.

**Installation values are one object.** `src/config/installation.ts` exports a
single `INSTALLATION` — vault, network, mesh, smtp, publicHosts, backup, shares,
and `hosts`, the boards keyed by name. It is the only place a committed service's
configuration may reach for the house, and an entry is handed it rather than
importing it. A host is `ramMb`, `ageRecipient`, `adminKeys`, an optional
`services` list and an optional `backup` flag; its name is its key, which is also
the stack name and the ssh alias, so nothing carries the name twice. The
1Password vault's name is a field on it for the same reason as the rest: the item
and field names belong on the catalog entries, since a stranger creates the same
ones, but which vault holds them is one installation's. A default in `src/infra/`
would be one house's vault name that every other deploy read without being told
— and `tests/catalog.test.ts` counts it among the values a committed entry may
not spell.

**A clean clone is an invariant, not an aspiration.** Copy the two
`.example.ts` files over their real names and `yarn validate`, `yarn render` and
`image/build.sh` all work — that is the first thing anybody adopting this does,
and it is the thing most likely to rot silently. CI's validate job is that clone
(it copies both and renders), and `tests/catalog.test.ts` holds the contract
shut: `.gitignore` names exactly those two, and each has a committed twin.

**A catalog entry is not done until all three halves are there.** Most services
need plain `env` (database path, `0.0.0.0` bind for bridge networking, base
URLs), `secretEnv` naming vault fields that actually exist, and a
`/var/lib/<name>` volume — a spec carrying only its secrets crash-loops on the
board. When porting from `../raspi`, diff the entry against the old task's
whole env-and-volume picture, and route the values that name the installation
through `setup` rather than into the committed `env`.

**A house app's data mount is `:Z,U`.** The sibling-app images run as uid 1000,
and the unit creates `/var/lib/<name>` as root — without `U` (podman chowns the
source to the container's user) the app cannot open its own database. `U` stays
per-entry rather than automatic, because an image that runs root outside but
owns files as internal users — pihole — would have its data tree chowned to
root by the same flag.

**A house application is stamped, not copied.**
`src/config/templates/houseApp.ts` is the shape the sibling apps share — one
loopback port, one SQLite file under `/var/lib/<name>` at `/data`, a vhost, a
session key of its own, an apps-tier cap — as a constructor, so bringing one over
is six facts instead of thirty lines, and `yarn spec <name>` prints everything the
six expanded to. It returns a **plain `ServiceSpec`**: a catalog holds the result
rather than a reference to the recipe, so every consumer is untouched and the
template can be rewritten without editing a catalog. Every convention has an
opt-out, and needing more than two of them means writing the entry out — somebody
else's product is a literal entry from the first line, because a released image
is digest-pinned rather than a tag its CI moves, keeps its data where it chooses,
and signs no session with a key from a vault item named after it. Unstamping is a
hand translation rather than a paste: `yarn spec` prints an entry resolved, so
the setup's two URLs arrive merged into the environment, and a literal entry
composes them from the identity role instead of hard-coding the zone.
`tests/houseApp.test.ts` spells one stamp's literal equivalent out.

**A template derives what the deployment owns, and states nothing about what the
application owns.** The mount, the backup, the tier, the vhost, the published
port, the network, the OIDC variables and `SESSION_KEY` mean the same thing
behind any image — those are derived, and any other `ServiceSpec` field is an
override that replaces the derived value while `env`, `secretEnv`, `mounts` and
`setup` merge with it. The _name_ of the variable an application reads its listen
address or its database path out of is that application's vocabulary, and
inferring it from a deployment label is a guess: across the five apps this shape
was written for, `<NAME>_BIND` is right twice and `<NAME>_DB_PATH` four times
(`NIB_PORT`, `REPRESENT_BIND`, `PORT`, `SCRIBE_BIND`, `PORT`; `NIB_DB` is the odd
database). And the guess fails silently — rename the variable in the app and the
catalog keeps setting the old one while the app falls back to its own default
path, putting its database outside the directory the nightly snapshot covers. So
the entry states its own `env`, and the template passes it through without
adding to it, renaming in it or reading it: what the bind should say is the
application's contract too, and a wrong one fails loudly enough on its own — the
proxy dials the port and gets no answer at the first request.

**`auth: "oidc"` implies `egress: "host"`, and the template refuses any other.**
A client makes half the login itself, to the issuer's own vhost, and every route's
allowlist plus the packet filter admit the LAN and the mesh only — the host's
address is in both sets, a bridge address is in neither, and the internal bridge
has no route off the host at all. So a client on a bridge deploys clean and dies
on the back channel at first use; `deploymentGaps` refuses the combination for a
literal entry too. Under host networking the bind is a host bind with no
`PublishPort` narrowing it, so such an entry states `127.0.0.1:<port>` — which is
what the gate does and what the four apps on the old card do.

**What host networking costs is the isolation between apps, not only the egress.**
The host's namespace is where every service's loopback upstream is: the identity
provider's port, the vault's, the gate's forward-auth endpoint, and every other
app's — reachable directly, past the route allowlist and past the gate, by
anything sharing that namespace. On `keel-internal` an app can reach none of them,
which is why **`auth: "edge"` is the posture an app arrives on**: the gate holds
the only client, the app keeps the bridge, and the identity arrives in a header.
`auth: "oidc"` is for an app that has to run the flow itself, and it is a
statement that the app is trusted with the board's loopback. Nothing in the packet
filter constrains that — a namespace is not a hop — so it is a review decision per
entry rather than a check.

**No live entry gets restamped without a golden diff.** A service's restart
trigger is a hash of its quadlet body, so an environment variable that moved in
insertion order restarts the resolver, the proxy, the identity provider or the
vault — for no behaviour change at all. The template is the interface for entries
that arrive from here on. Rewriting one that is already deployed means showing
`tests/__snapshots__/golden.test.ts.snap` unchanged (run under `CI=true`, so
vitest cannot rewrite what it is asserting) or stating the restart as the point of
the change.

**A template names no catalog service.** What a stamped entry needs of another
service it takes as an argument — the identity provider's vault item, since a
`secretEnv` reference is resolved before any role is — or asks for by role inside
`setup`. A template that named one would be a template for one thing, and
`tests/service.test.ts` holds `src/config/templates/` to zero mentions rather
than to the one every other module is allowed.

**The host's entry is the only selector.** `mine` is the whole catalog, or
exactly the entries the host's `services` list names — a name no entry is called
stops the plan at its start, because a typo that filtered to nothing would deploy
less and say so nowhere. There is no per-stack allowlist beyond that to bring a
subset up in stages. What such a list would stand in for is ordering, and
ordering is in the graph: `orderServices` topologically sorts the deployed
set and the program walks that order, so each `Service` is handed the _resources_
of the ones it needs running. Two edges are derived from declarations an entry
already makes — a service with `auth: "oidc"` after the identity provider whose
discovery document it fetches at startup, a service with `certificates` after the
proxy whose store the copy comes out of — and `dependsOn` is the rest, by name,
for edges nothing implies. It is ordering and never selection: a name the host's
`services` list leaves out stops the plan rather than pulling the entry in, as
does a name no entry is called and a cycle, which is reported as the loop.

Deliberately **not** derived: "a service with a vhost depends on the proxy". A
route file needs nothing running to be written, and the rule would be a cycle —
the resolver has a vhost, and the proxy is ordered after the resolver so its
DNS-01 challenge resolves the registrar's API through the LAN's own resolver.
That edge is a preference and not a precondition: `resolv.conf` is static, and
the public fallbacks it lists after `127.0.0.1` exist so a query answers before
Pi-hole does — the proxy would reach the API with the resolver down, paying a
timeout per query on an unfiltered path.

**A fresh host is one `pulumi up`.** The failure that used to need a human
sequencing it: Kanidm exits without `/etc/kanidm/certs/chain.pem`, that file comes
from the cert-sync one-shot reading the proxy's ACME store, and the proxy starts
answering minutes before DNS-01 completes. Three things close it. The proxy's
start job means "answering" (`traefik healthcheck` against a ping entry point in
its own static config). The cert-sync one-shot **waits** for a wildcard to appear,
bounded by the store's `settleSeconds`, so the certificate is a precondition
rather than a race. And Kanidm's start job means "serving TLS", so a certificate
that never arrives fails the deploy by name instead of leaving a crash loop that
`systemctl start` reported as success.

Every link in that chain is a start job that means _answering_, the resolver's
included: Pi-hole's `healthCmd` is a `+norecurse` query for its own name, so
"the resolver before the proxy" orders against a resolver that answers rather
than against a running container. `Notify=healthy` is what turns a check into
the start job's verdict, and `TimeoutStartSec=600` is what pays for it — a first
start also builds gravity.

**A failure reaches a phone without anyone looking.** The image polls: every
five minutes `keel-alert.service` (`src/render/alert.ts`) lists the units that
are failed or stuck in `auto-restart`, posts each new one once with its journal
tail, and posts once more when it recovers. Where it posts is the catalog's to
say — the entry that declares the `alerts` role (ntfy, with its topic) is the
sink, the deploy writes `/etc/keel/alert.conf` from it, and no claimant means an
empty file and a silent poll. Polling and not `OnFailure=`: a quadlet's
`Restart=always` keeps a crash-looping container in `activating (auto-restart)`
and never in `failed`, so a hook would fire for nothing, and a hook is a line in
every unit body, which is a restart of every service.

**A status page is derived, not written.** gatus's `setup` reads
`catalog.services` and the installation's SMB servers and writes one check per
deployed service, dialled on loopback rather than through the proxy — a bridge
service publishes its port there and a host-networked one binds it there, so
every entry has a listener to dial and the proxy's own check still runs while
the proxy is the thing that is down. Adding a service adds its check; nothing
spells one out by name. The alert goes where the poller's already does: the
`alerts` role's sink, over the topic it claims, so one phone carries both
signals. The trade is the one an OIDC client makes — reaching every service's
loopback port means running on the host's own network stack, past the route
allowlist and the gate both.

**A credential only two machines need is generated where it is used.** The
metrics hub's read-only account for the dashboard is created by the deploy: the
entry declares `metricsAccount` and the two variables its application reads the
login out of, the hub is whichever entry claims the `metrics` role, and
`MetricsAccount` (`src/infra/providers/metricsAccount.ts`) authenticates as the
hub's superuser, upserts the account, assigns it to every system, **generates the
password inside the call and seals it for the host in the same one**. So it is in
no vault, in no state file and in nobody's clipboard — it lands as
`/etc/secrets/<name>.metrics.env.age` and reaches the container as a second
`EnvironmentFile=`. That follows the rule rather than bending it: keel makes no
vault writes, so a generated secret that had to be stored would have needed one,
and a password no person ever types loses nothing by nobody knowing it. `read`
asks the hub whether the account still exists — gone in its UI is gone here, and
the next deploy creates it again with a fresh password — and never re-generates,
because a rotation on every refresh would restart the consumer for no change. A
`metricsAccount` with no hub deployed is a `deploymentGaps` error, and the
account's resource is ordered behind the hub's unit, because an account is made
by calling something that answers.

**A service that boots unclaimed is claimed by the deploy.** The mesh
coordinator ships with no account and answers one unauthenticated call that
creates the owner and hands back a plaintext access token — shown exactly once.
`BootstrapAccount` (`src/infra/providers/netbirdAccount.ts`) makes that call from
the board, draws the owner's password inside it, and returns the token as a
**secret output**. That is the one credential in this repository that lives in
Pulumi state: the server minted it, keel makes no vault writes, and the
alternative is a person pasting something before every run. The owner's password
is kept beside it because the token expires at the server's 365-day cap and the
local login is the only way back into the account that can mint another — an SSO
login lands in a _different_ account, since the broker keys an identity on the
subject its connector issues and a federated subject can never equal a local one.
The entry declares the paths, the auth scheme, the token's lifetime and the vault
field a hand-minted token is read from; the address is derived, as the hub
account's is.

`read` asks whether the account is still there and the token still opens it, and
answers with the id or with nothing — a wiped store and a revoked token both read
as gone, and the next `up` claims a fresh coordinator or **fails by name** against
one that is already claimed. That failure is the one place a `create` cannot
converge, and its message is the recovery: mint a token in the dashboard and put
it in the vault field. That field is read _before_ the setup call, so the manual
path exists whether or not the automatic one ever worked. `delete` does nothing —
deleting the only account of a running mesh is not something a `pulumi destroy`
decides.

**A connector is registered once and never deleted.** `BootstrapConnector` is the
second resource, ordered behind the account whose token authorises it, and it
registers the identity role's issuer on the coordinator's own broker so that
signing in there is the fleet's single sign-on. Its `delete` is empty and that is
load-bearing rather than cautious: a federated identity's subject is minted from
the user's id _and the connector's_, so a connector deleted and registered again
gives everyone who has ever signed in a subject the coordinator has never seen —
which is a brand new, empty account each. So it is matched by name, corrected with
a PUT on the id that is already there, and it outlives the stack. Its client
secret is the identity provider's to generate: `kanidm/netbird_client_secret` is
registered by hand exactly as `kanidm/oauth2_proxy_client_secret` is, and an empty
field fails by name.

**The mesh's own state is a bridged provider's, not a client written here.**
Everything behind the coordinator's API — the account settings, the groups, the
keys a device enrols with, the networks the routing peer carries and the DNS
those peers use — is declared in `src/infra/netbird.ts` against
`@pulumi/netbird`, the SDK `pulumi package add terraform-provider
netbirdio/netbird` generates under `sdks/` and this repository commits, source
tree and compiled `bin/` both, because CI installs `--immutable` and yarn runs
no build scripts. It is the trade the public DNS records already make and a
sharper one: twenty-four resource types and twenty-five data sources arrive with
a real `read` and a real `diff` each, so a group renamed in the dashboard is
drift on a refresh and a
retired route is a deletion in the deploy that retired it — where the old
repository's reconciler could only converge forward, creating what was missing
and correcting what had drifted, because a list-and-compare has no way to tell a
resource somebody else made from one it made and has since stopped declaring.
**The token is the resource's and never the environment's**: `BootstrapAccount`
returns the coordinator's access token as a secret output, that output
configures an explicit `netbird.Provider`, and every resource is handed it — so
nothing is exported to the process, no vault field holds a second copy, and the
whole file is ordered behind the account by the plain fact that a provider
cannot be configured before its token resolves. The cost is the address. A
bridged provider is a plugin process running where Pulumi runs, so unlike every
device provider, which reaches the board over ssh, and unlike the two bootstrap
resources, which deliberately make their calls _on_ the board so the coordinator
is dialled on its own loopback, this one dials the coordinator's **public
vhost** from the deploy machine. **So this stack now has to reach that name from
wherever a deploy is run**, and a preview reaches it too: resolving a group's id
and the routing peer's address are provider invokes, which fire whenever the
program is evaluated — the same shape as the Cloudflare zone lookup, for the
same reason.

---

A second, shorter one, if the routing peer is worth its own line — it is the one
decision in the port that could have gone the other way:

**A route names a peer, and the board is that peer.** The networks the mesh
carries and the DNS it answers with are both the board's own agent's, resolved
from the coordinator by the name that agent enrols under — one string on the
entry (`routingPeer`), passed to `netbird up --hostname` and looked up again by
the routes, so there is nowhere for the two to disagree. The agent is a package
and a unit rather than a quadlet, because the client holds a WireGuard
interface, opens `/dev/net/tun` and installs a packet-filter table of its own:
a container would need the capabilities, the device and the host's network
namespace, which is every isolation a container buys given away, and a quadlet
cannot say the rest. So the image installs it (`src/render/mesh.ts`,
`keel-mesh.service`) and the deploy says which mesh: `MeshAgent`
(`src/infra/meshAgent.ts`) seals the setup key for the board, checks the client
is actually on the booted image, and `MeshEnrolment` runs the one call. The peer
lookup that follows is ordered behind it — `dependsOn` on an _invoke_, which the
engine holds until the resource exists and answers as unknown during a preview —
so a fresh installation's routes are created in the same `up` that enrols the
agent, and a preview of a board that has never enrolled plans them instead of
failing at a name it was about to create.

**The agent's profile is not the coordinator's data directory, and that is a
decision.** The client's own default state directory is `/var/lib/netbird`,
which on this fleet is where the _coordinator's_ SQLite store lives — keel
derives a service's data directory from its entry's name, and the two halves of
NetBird carry one name. Left alone they would share it: the peer's private key
inside the tree the nightly snapshot covers, inside a bind mount podman relabels
at every container start, and a restore of the coordinator's store clobbering the
board's own identity. `NB_STATE_DIR` on the unit moves it to
`/var/lib/netbird-agent`, and a test holds it clear of every deployed service's
`/var/lib/<name>`.

The unit is `keel-mesh.service` for a related reason: `netbird.service` is the
name quadlet generates for the coordinator's container, in
`/run/systemd/generator`, which outranks `/usr/lib/systemd/system` — a unit of
that name in the image would be shadowed by the container's on the one board
that runs both, and the daemon would silently never start.

**And it talks to the hub from the board, not from here.** Each method sends one
small Python program to the board's `python3` on stdin and reads a JSON line
back — one ssh session that waits for the hub, authenticates and does the whole
operation, rather than a session per call — so the address is the hub's
_loopback_ origin, the same one the consumer's own configuration dials. A
provider that reached the vhost from the deploy machine works until the machine
it runs on cannot route to the LAN, which is a property of somebody's laptop and
not of this fleet: a stray reject route made `net.connect` answer `EHOSTUNREACH`
where `curl` returned 200, and nothing about the board was wrong. Every secret
rides in on that stdin, base64 inside the program text — never an argument,
never a file on the board, never in a diagnostic; `ps` there sees `python3 -`.
The script prints an id and fails with a sentence and an HTTP status.

**A LAN name is a line in a hosts file the resolver re-reads.** Pi-hole's own
`setup` derives the record set from `catalog.services` into
`/var/lib/pihole/hosts/keel.list`, one `<lanAddress> <subdomain>.<domain>` line
per deployed vhost, and dnsmasq's `hostsdir` picks the file up on its own — so
adding a vhost is a hosts line and retiring one removes it, both in the same
deploy that changed the catalog, and the resolver never restarts either way.
Public records (`publicDns: true`) are keel's too now — see the next paragraph.

**A public name is a `cloudflare.DnsRecord`, and its token is in the deploy's
environment before Pulumi starts.** `src/infra/index.ts` declares one A record
per `publicDns: true` vhost — service and remote alike, from
`publicRecords(catalog, INSTALLATION.network)` in `src/config/spec.ts` —
pointing at the same `lanAddress` the hosts file does, through the official
`@pulumi/cloudflare`. So a record edited by hand in the dashboard surfaces as
drift on a refresh the same way a rotated secret does, and retiring the entry
deletes the record in the same deploy, with no hand-written API client in this
repository to keep abreast of somebody else's product. The zone is one
`getZoneOutput({ filter: { name: domain } })` for the whole host rather than one
per record, and a host with no public name looks it up not at all. The token is
the `cloudflare` login item's password — the same field the proxy's DNS-01
challenge reads — and it reaches the provider as `CLOUDFLARE_API_TOKEN`, put
there by `scripts/pulumi.ts`, which reads the vault and loads `.env` before it
spawns the CLI. That is the trade this provider is worth: it configures itself
while the program is being evaluated, which is `preview` as much as `up`, so
**a preview of this stack now reads the vault** and wants a terminal 1Password
can prompt. The zone the old repository populated is adopted by recreation
rather than imported — the first `up` after this change creates the provider's
records and deletes the dynamic ones afterwards, since Pulumi runs deletions
last, so each name carries two identical A records for the length of one run
and ends with one.

**A route to another machine is an entry of its own shape.** A `RemoteSpec` is
a vhost whose upstream is not on this board: it gets the route, the LAN record
and the check, and none of what the board owns — no image, no unit, no cap, no
firewall rule, no backup. The committed catalog ships none, the same reason the
service one names no house: a stranger's own infrastructure has no place in an
example everybody adopts. A remote may not share a name with a deployed
service (Traefik's router and service names are one namespace) or a subdomain
with a service or another remote, and `auth` means the same as it does on a
service except `oidc`, which a remote is refused outright — it runs its own
login flow or none, because the board has no client to hand something it does
not run.

**A vhost may carry more than one router, and the priorities are the entry's to
state.** `routers` on a `ServiceSpec` replaces the single router a vhost derives
with one router and one load balancer per element — a suffix on the entry's name,
a rule fragment ANDed with the vhost's `Host()`, a port, and a priority. The
priority is stated because Traefik's own default is the length of the rule: an
order nobody wrote down, which changes when a path is added to a match and hands
the catch-all what the API was answering. `scheme: "h2c"` dials an upstream as
cleartext HTTP/2, which gRPC needs — over a plain HTTP/1 backend a client fails
on the content type, which reads as the application's bug rather than the
route's. **Every router on the vhost carries the same middlewares**: the
allowlist and the gate chain are keyed to the name a request arrives on and never
to the router that matched it, so several routers are a division of one vhost's
paths rather than a second answer to who may reach it. `deploymentGaps` refuses
the ways that division is written wrong — two routers under one name, two Traefik
would pick between arbitrarily, a match spelling a `Host(` of its own, more than
one router with no match, and routers on an entry with no vhost. netbird is the
entry that needed it: management and signal are gRPC on an h2c upstream, the REST
API and the relay's websocket are HTTP/1 on the same port, and the dashboard SPA
is another container behind the catch-all.

**`merge()` refuses duplicate paths.** Two renderers writing one file is always a
bug. Do not work around it by renaming the file.

**Every invariant is a test, not a comment.** Port collisions, per-profile memory
budgets, no address or host name anywhere in the tree, no key material in it —
see `tests/`. A new invariant that only exists in prose will drift. The rendered
tree itself is a golden (`tests/image.test.ts`, every path with its mode), so a
test that only pins prose the renderer wrote is not an invariant and does not
belong: the snapshot already holds the line, and what a test adds is the rule
behind it — what the board would be silently wrong about if it regressed.

**A public name opens the proxy's port, and nothing else opens it.** A subdomain
in `publicHosts` is answerable from anywhere or it is nothing: Traefik matches on
the Host header, so that route has already stopped guarding the vhost by source
address, and a filter that still dropped :443 from the internet would leave the
opt-out true in the proxy and false one layer down. So `publicProxyIngress`
derives the world-facing rule from the deployed set — the proxy's own port, and
only when a deployed vhost's subdomain is named there. Derived rather than
declared, because the proxy's entry is committed: an `ingress` line there would
open 443 to the world for every clone, including the ones whose `publicHosts` is
empty and whose 443 should answer the LAN alone. The mesh coordinator is the
entry this exists for, and a name nothing deploys opens nothing.

**The packet filter fails closed.** `table inet keel` ships with policy drop, the
traffic a machine needs to be on a network at all, SSH, and named sets that are
empty. An empty set matches nothing, so an image nobody has configured admits
nothing — no list has to be accurate for that to hold. Elements arrive in
`/etc/keel/nft.d/*.nft`: `keel-firstboot` writes the address ranges, and every
`ingress` the deployed set declares becomes one `50-services.nft` the program
writes. nft merges a re-declared set additively, so a drop-in adds without
restating the table.

**Forwarding is host policy, and the accept that uses it is the deploy's.** A
routing peer forwards between the overlay and the LAN, which the kernel refuses
with `ip_forward` off — so the image states it
(`/usr/lib/sysctl.d/99-keel-forwarding.conf`) rather than leaving it to whatever
the client does to the machine behind everyone's back. On every board, safely,
because `table inet keel`'s forward chain is policy drop: a board with nothing to
forward for forwards nothing. What decides whether a packet crosses is
`20-forward-open.nft`, which the deploy writes from the deployed set — the open
bridge's egress where something is on that bridge, and `iifname "wt0" accept`
where the entry says this board enrols as the routing peer. Neither is in the
image, for the same reason: which board routes is a property of what it runs.

## Secrets

Secret _values_ never appear in this repo or in the image, and a value that came
out of the vault never appears in Pulumi state.

Pulumi writes `/etc/secrets/<svc>.env.age`; the age identity that opens it lives
only on the host, at `/etc/keel/age.key`, placed once by hand. So the state file
holds a blob it cannot read, `keel-secrets.service` decrypts it at boot, and the
quadlet reaches it through `EnvironmentFile=` — no vault value is ever a resource
input.

**Two exceptions, and both are values nobody ever types.** A `ServiceSecretFile` on a
`setup` is a configuration file whose body carries key material — netbird's
`config.yaml` and its three keys — and the deploy draws those with
`@pulumi/random`, composes the body from them, and seals it with `SealedText`
before `SecretFile` writes it. The drawn values are secret outputs and the body
is a resource input marked `pulumi.secret()`, so what the checkpoint holds is
ciphertext under the **stack passphrase** rather than under the board's age
identity. That is a real difference from everything else here: `state/` is
gitignored and Syncthing-carried, and the passphrase is what stands between it
and those keys. It is still not a captured value — capture is what serialises a
secret into state in the clear, and the rule against it is unchanged. A
`GeneratedSecret` marked `protect` is one a replacement would cost data for:
netbird's `store.encryptionKey` is the only key to the mesh's whole store, so
Pulumi refuses to redraw it and removing the flag is the decision.

The second is the coordinator's own access token and the owner password beside
it, minted and drawn by `BootstrapAccount` and held as `pulumi.secret` outputs —
under the same stack passphrase, for the reason above: the server issues the
token once and there is no vault write to park it in.

**Rotating one is `yarn deploy`.** The vault is not a resource input, so
a bare `up` compares the inputs it has — the item and the field names — and finds
them unchanged. `SealedEnv`'s `read` is what asks 1Password what the value is
now, and `read` runs on a refresh: a value rotated there surfaces as drift on
that resource, and the new hash cascades from it into the blob, the decrypt and
the restart of the service that reads it, all in one run. The same command picks
up a moved rolling tag, for the same reason. A `SealedEnv` prompts on `up` and on
`refresh` and never on a preview; what prompts before every `yarn preview` is a
different read for a different reason — the Cloudflare token `scripts/pulumi.ts`
puts in the environment. A field name invented to look plausible
fails at deploy time with `<item>/<field> is empty or unreadable` — check field
names against the vault, not against a guess; the old repo's `group_data`
declared fields its `secrets.py` never wrote.

`src/config/keel.ts` is committed and holds what the image renders from — the
name of the account first-boot creates and the group sshd and sudo actually match
on, unbound's port, the module deny list, the journal cap, the fallback
resolvers. `src/config/installation.ts` (one `INSTALLATION` object, the boards
included) and `src/config/services.local.ts` are gitignored and hold non-secret
configuration only — addresses, domains, image references, version pins.
Syncthing carries both between the admin's machines, together with the local
catalog's golden; `.stignore` is the whitelist that says so.

Do not read secret values into context. Reading `/etc/secrets/*` off a host, or
`op read`/`op item get` on a value, dumps plaintext into the transcript. Using a
secret inside a remote command is fine; transporting it here is not.

## Memory profiles

`src/config/profiles.ts` defines profiles (`1g`, `4g`, `8g`) and the arithmetic
that prices a cap against one. The caps themselves live on the entries that
declare the services — `IMAGE_SERVICES` here holds only unbound's, because a
package has no catalog entry to hang a number on. Which profile applies is
decided twice, by two layers that know different things:

- **The image sizes the tiers.** A systemd generator reads `MemTotal` at boot and
  stages that profile's slice budgets — `MemoryLow` on `keel-core.slice`, the
  room left over as `MemoryHigh` on `keel-apps.slice` — plus the caps for the one
  service the image itself runs, unbound. `keel.mem_profile=<name>` on the kernel
  command line overrides the choice, which is also how `image/test.sh` exercises a
  profile the build host does not have the RAM for.
- **Pulumi caps the service.** `Host.ramMb` selects the profile, and `Service`
  writes `/etc/systemd/system/<name>.service.d/50-keel-memory.conf` beside the
  quadlet. `/etc` outranks both `/usr/lib` and the generator's own directory, and
  the image stages nothing for a service it does not run, so there is one owner
  and no ordering question.

`selectProfile()` in TypeScript and the awk in the generator implement the same
rule against `/usr/lib/keel/profiles/index`. A test asserts the index matches
`PROFILES`; that test is the only thing stopping the two from drifting.

Two slices: `keel-core.slice` (resolver, proxy, identity) is protected from
reclaim and systemd-oomd never targets it. `keel-apps.slice` is where pressure is
resolved. `MemoryHigh` is overcommitted deliberately; only the core tier's hard
caps are held inside a budget.

## Traps

- **Reboot-to-apply, but only for the image half.** A service change — core or
  app, pihole and traefik included — is `pulumi up` and a container restart, and
  so is the port it needs open. A change to the OS, the filter's own table and
  rules, the memory profiles or unbound is a new image digest and a reboot — a visible outage on the host that serves LAN DNS,
  so batch those. Batching still matters with the weekly update timer in place:
  it applies whatever CI last published, so a change meant to land with others
  belongs in the same merge, not a separate one before that week's window.
  `bootc usr-overlay` is for transient debugging only.
- **`keel.conf` is read at every boot, not only the first.** `keel-firstboot`
  converges: it compares before it writes, so a steady-state boot touches nothing
  under `/etc`, and changing a host's name or ranges is editing the file on the
  ESP and rebooting — not a rebuild. On a card that has no `keel.conf` the unit
  is inactive rather than failed, which is what keeps greenboot from rolling back
  an image nobody has configured yet.
- **A rollback does not blocklist the digest it rolled back from.** greenboot
  undoes a bad boot, but `bootc-fetch-apply-updates.timer` has no memory of why —
  it re-stages the same digest at the next weekly window regardless. The fix for
  a bad image is publishing a fixed one before that window, not disabling or
  outrunning the timer.
- **A quadlet sets `Slice=` and no memory caps.** The numbers come from the
  drop-in `Service` writes under `/etc/systemd/system/<name>.service.d/`, from the
  profile the host's `ramMb` selects. Putting `MemoryMax=` in the quadlet as well
  would give two mechanisms an opinion about one service, and the survivor would
  depend on load order rather than on a decision.
- **A Pi has no clock, so every `Persistent=true` timer fires on every boot
  unless the timers wait for time sync.** The board boots believing it is the
  moment the image was built; chrony steps the clock forward by weeks a minute
  later. A persistent timer loaded before the step logs `Not using persistent
file timestamp … as it is in the future`, discards its stamp, and when the
  clock lands treats every calendar elapse in between as missed — the backup,
  the prune and the podman prune all run at once, into the boot's busiest
  minute. The image enables `chrony-wait.service`, which holds
  `time-sync.target` until chrony reports the clock synchronised and gives up
  after 180 seconds, and every persistent timer the repo renders — the backup
  pair, the podman prune, the bootc update window — carries
  `After=time-sync.target`. The gate goes on the timers and never on
  `timers.target`: unbound orders after `unbound-anchor.service`, which orders
  after `unbound-anchor.timer`, so a `timers.target` that waits for the clock
  holds the resolver, greenboot, `boot-complete.target` and every quadlet
  behind them — a boot that never finishes on a board that cannot reach NTP.
  `systemd-time-wait-sync` is the wrong tool here as well: it watches the
  kernel's synchronised flag, which chrony leaves unset long after stepping the
  clock, so it never returns.
- **Two restic runs that meet contend for one lock, and systemd is not the
  arbiter.** The prune takes the repository lock exclusively; a snapshot that
  arrives meanwhile fails with restic exit status 11 (`unable to create lock in
backend`) unless it waits. No `Conflicts=` between the units — that would kill
  an in-flight snapshot to make room for housekeeping — so the backup script
  passes `--retry-lock 30m` to every restic invocation (`src/render/backup.ts`),
  bounded inside the units' own `TimeoutStartSec`. A loser that fails only after
  that wait is its own timer's problem at the next window.
- **`nft -f` merges; only a reload removes.** Re-applying a port file that no
  longer names a port leaves that port in the kernel's set. What closes it is
  `nftables.service`'s `ExecReload`, which re-reads `/etc/sysconfig/nftables.conf`
  — a file whose first act is `flush table inet keel`, then the base table, then
  the whole `/etc/keel/nft.d/*.nft` glob, in one transaction. One `SystemdUnit`
  in the program does that reload, triggered by the body of the file it reads.
  The flush is keel's table and nothing else, and the image overrides the stock
  unit's `ExecReload` to make it so: the stock `flush ruleset` empties netavark's
  table too, which holds the port forward of every running bridge container, so
  a deploy that reloaded the filter left every published port hanging until
  `podman network reload --all` or a container restart put the rules back.
- **The ports are one file for the host, and that follows from the merge.**
  Pulumi performs deletions after updates, so a per-service drop-in belonging to a
  retired service is still on disk when the reload re-reads the glob — the reload
  run to close that port re-admits it instead, and it stays open until some later
  reload. `50-services.nft` holds the whole deployed set's rules, so retiring a
  service is an _update_ of the file, in the same run that reloads from it. Both
  it and `20-forward-open.nft` are written even when they name nothing — a body
  of "no rules" that became an absent file would be a deletion again, and the
  reload would re-read the copy still on disk. Present and empty is what closes
  a port; absent is what re-opens it.
- **A first start pulls the image inside `ExecStart`, and systemd's default
  start timeout is 90 seconds.** A quadlet with `Pull=missing` (the quadlet
  default) pulls the image on the first `systemctl start`; podman gives itself
  a 5-minute pull timeout, but systemd's `TimeoutStartSec` default of 90s fires
  first on a Pi over a home uplink — the unit fails with "start operation timed
  out. Terminating.", the deploy's `systemctl start` returns 1 with no output,
  and `Restart=always` retries into a half-warm layer cache until a pull
  happens to fit. `renderQuadlet` (`src/render/quadlet.ts`) puts
  `TimeoutStartSec=600` on every unit for this, health-checked or not. A run
  that failed this way is finished by waiting for the units to come up on
  their own and running `yarn deploy` again, whose `create` on a running unit
  is a no-op `systemctl start`.
- **A bare `healthCmd` is run by the container's `/bin/sh`.** An image built from
  scratch — Kanidm's is — has none, and podman reports the missing shell as an
  ordinary failing check: exit 1, no output, nothing in the journal about a
  shell. With `Notify=healthy` the unit then fails at `TimeoutStartSec` for a
  reason that is not written down anywhere. Prefix the value with `CMD ` for
  podman's exec form, which needs no shell. Traefik's image is Alpine and has
  one, so its check is written as a plain command line.
- **A mountpoint is `/var/mnt/<share>`, never `/mnt/<share>`.** ostree's
  deployment root leaves `/mnt`, `/srv`, `/home`, `/root` and `/media` as symlinks
  into `/var` or `/run`, and systemd refuses a mount unit whose `Where=` resolves
  through one — `Mount path /mnt/music is not canonical (contains a symlink)`, and
  the unit fails with `resources`. The half-fix is the dangerous one: podman
  resolves the symlink when it binds, so a `Volume=/mnt/music` line keeps working
  while quadlet's derived `RequiresMountsFor=/mnt/music` matches no unit, leaving
  the service with no dependency on its own data. `mountedShares` refuses both
  spellings and names the canonical one. That derived line is also the whole of
  a service's ordering against its share — `Requires=` plus `After=` on the mount
  unit — so an entry states the `mounts` line and never the unit's name.
- **A mount has no `Restart=`, and an automount is not one.** A share whose
  server is off at boot fails once and stays failed, and every quadlet that
  binds a path under it ends its start job with "Dependency failed" — which
  `Restart=always` never sees, since the service did not run. An `.automount`
  does not change that: `RequiresMountsFor=` resolves to the `.mount` unit and
  never to the automount (`unit_add_mount_dependencies` in systemd's
  `src/core/unit.c`), so the service's start still pulls the mount job and still
  fails on it; the trigger would serve a shell, not a container. What retries is
  `keel-remount.timer` (`src/render/remount.ts`): every five minutes it starts
  each failed mount whose source is a network path, and for each that comes up
  starts the units in its `RequiredBy=`. A start on an active unit is a no-op,
  so a quiet tick touches nothing. The same tick restarts an _active_ mount
  whose `statfs` does not answer within ten seconds: a server that moved keeps
  the mount active and every access answering `Host is down`, and a mount
  reads the name only when it mounts.
- **A missing `mount.cifs` does not reject `credentials=`, it ignores it.** The
  option is the helper's, not the kernel's, and the helper is image content — so
  on a board whose booted image predates `cifs-utils`, util-linux mounts through
  the kernel, which parses the option list itself and drops what it does not
  implement. The share then comes up with no login at all: against a server that
  demands one it fails at authentication instead (SMB signature verification
  returns `-13`, `mount` exits 32), and against one that permits guests it
  **succeeds** and looks like a working share. Against the server this fleet
  uses the first case is what happens — it refuses guests, so the mount fails at
  authentication — but that is a property of the server, not of the deploy. What
  makes it a property of the deploy is `RemoteBinary`
  (`src/infra/providers/remoteBinary.ts`): `CifsMount` puts one ahead of the unit
  as `<unit>-helper`, it `test -x`es the helper on `create` and on `read`, and it
  fails by name — so the run stops before systemd is handed a mount that would
  have had no login. greenboot cannot ask this: the selftest runs on the image
  that just booted, which is the one that has the helper, while the question is
  whether the _host's current_ image does. So a host's first share is a new image
  digest and a reboot first, then `yarn deploy`.
- **A router's share moves; name it and let the image find it.** A router that
  hands out an address by DHCP reservation does not always keep the reservation,
  and when it moves, its own DNS never hears about it and it advertises no mDNS
  either — the one thing that still answers for it is a NetBIOS NAME QUERY
  broadcast to UDP 137, what `smbutil lookup` and `nmblookup` do by hand. The
  board runs no name service of its own, and the kernel's CIFS driver resolves
  nothing — `mount.cifs` reads a name through `getaddrinfo`, which reads
  `/etc/hosts` before it asks anything else. So `keel-hosts.service` sends that
  broadcast for every name a share or the backup target is given, at boot and
  every five minutes, and writes the answer into `/etc/hosts`. The backup mounts
  by calling `mount(2)` directly, which takes no name at all — its script
  resolves the host itself and passes the address as the CIFS `ip=` option, the
  same file `mount.cifs` would have read. The filter has to let the answer in:
  the query goes to the broadcast address and the node answers from its own, so
  conntrack pairs nothing and `established,related` does not match — `keel.nft`
  accepts UDP from source port 137 off the LAN set for exactly this, the same
  shape as its DHCP rule. Without that line the query works from any laptop and
  never from the board. And the deploy _reloads_ the unit rather than starting
  it: a oneshot with `RemainAfterExit` that ran at boot is active, so `systemctl
start` on it is a no-op, and a name list written after boot would sit
  unresolved while the mount units written beside it failed on it. `ExecReload=`
  is the resolver itself. The five-minute timer fires a second unit,
  `keel-hosts-refresh.service`, and not that one: a timer's start job on a unit
  that is still active is the same no-op, and `OnUnitActiveSec=` counts from an
  activation that never recurs — the first image's timer fired once at boot and
  never again, and a server that moved back to its old address went unnoticed
  until the status page's check on it went red. And a reload is a verb the
  _booted_ unit has to know: a deploy run against an image whose copy has no
  `ExecReload=` fails at that resource, and Pulumi stops the run there. When a
  commit changes both halves, the image lands first and `yarn deploy` follows
  the reboot.
- **A SELinux policy commit costs about 38 seconds on a Pi 4, and unbound waits
  on it.** `semanage port -a`/`-m` and `setsebool -P` each rebuild and commit the
  whole policy store, and `keel-selinux.service` (rendered by
  `src/render/selinux.ts`, its script `/usr/lib/keel/converge-selinux`) is
  ordered `Before=unbound.service`, so every commit it makes is LAN-DNS downtime
  at boot — three commits on a first boot cost 4.5 minutes of userspace before
  the resolver can start. The script reads before it writes: `semanage port -lC`
  and `getsebool` decide whether anything needs committing, so a steady boot
  commits nothing. The first boot on an image that changes either fact still
  pays once. A third SELinux fact added here follows the same shape.
- **A container reads a CIFS share only under `virt_use_samba`.** container-selinux
  gates `container_t` on `cifs_t` behind that boolean, off by default, and a
  share that mounted fine then answers every file with `Permission denied` from
  inside the container — a music server with an empty library and a deploy that
  looked clean. The policy store is machine-local, so the image cannot carry the
  setting: `keel-selinux.service` converges it at every boot, beside unbound's
  port label, and both are why that unit has no `ConditionPathExists=` on its
  tools.
- **The first boot after `bootc switch` is slow, and ssh comes back last.**
  Deploying the new image, greenboot's checks, and — on the boot where the
  SELinux unit's policy commits actually land — those commits put the first ssh
  answer about six minutes after the reboot on a Pi 4; a probe that gives up
  after two minutes concludes the board is dead. Wait, then check
  `systemd-analyze blame` and `systemd-analyze critical-chain unbound.service`
  before touching anything.
- **An `edge` service trusts the identity header only from an address, and on
  a bridge that address is the gateway.** The gate's verdict reaches a service
  as `X-Auth-Request-User`, copied onto the request by the proxy, and a service
  that consumes it (navidrome's `ND_REVERSEPROXYWHITELIST`) accepts it only from
  the sources it is told to. Under host networking the proxy arrives from
  `127.0.0.1`; on a bridge netavark masquerades traffic into a published port,
  so it arrives from the bridge gateway — `NETWORKS.<kind>.gateway` in
  `src/config/keel.ts`, pinned for exactly this reason. A whitelist that still
  says loopback fails the way this does: Kanidm login succeeds, the gate passes,
  and the service shows its own login form.
- **The camera cannot run here.** The CSI stack needs the Raspberry Pi vendor
  kernel's `bcm2835-unicam`/`bcm2835-isp`, absent from every mainline kernel, and
  Picamera2 supports Raspberry Pi OS only. `ocular` stays on the `../raspi` card.
- **Raspberry Pi bootloader.** `bootc`/ostree expect GRUB2, syslinux or U-Boot;
  native Pi bootloader support is still an open upstream request. The working
  path keeps the Pi's firmware out of `/boot/efi` entirely at build time —
  `bootupd` manages `/boot/efi/EFI` only and has no support for firmware at the
  ESP root (coreos/bootupd#651) — and lets `image/finalize-card.sh` place it
  there once the card build has a real disk to write.
- **Interpolating a multi-line block into an indented template literal** gives the
  first line a different indentation from the rest. Compose computed multi-line
  output line by line instead — see `src/render/selftest.ts`.
- **A fresh installation's first `up` stops at the one vault field that cannot
  exist yet.** `kanidm/oauth2_proxy_client_secret` is issued when the gate is
  registered as a client of a _running_ Kanidm, so the resource that seals the
  gate's environment fails by name — `kanidm/oauth2_proxy_client_secret is empty
or unreadable`. Where in the run it fails is deliberate: **a `SealedEnv`
  carries the same dependencies its service does**, so the read happens after
  Kanidm is up rather than in the first seconds. Without that edge
  it is a root of the graph — Pulumi stops an update at the first error, so the
  read would fail immediately and kill the run that was going to make the field
  answerable, which is a bootstrap with no fixed point. Register the client
  against the Kanidm that run brought up, put the secret in the vault, and run
  `up` again. That is the whole bootstrap: there is no staged subset, and the
  ordering a subset stood in for is in the graph.
- **Pulumi previews by evaluating the program.** Any side effect in the program
  fires on `pulumi preview`. Generated secrets, registry lookups and prompts must
  live behind a resource, never at module scope — which is what `ImageDigest` and
  `SealedEnv` are for. `src/infra/index.ts` still calls nothing that shells out,
  and a preview run with `op`, `skopeo`, `podman` and `age` off `PATH` is how
  that is checked. What a preview does now reach is Cloudflare: the zone lookup
  is `@pulumi/cloudflare`'s own invoke and the provider configures itself from
  `CLOUDFLARE_API_TOKEN` while the program is being evaluated. Without that
  variable the whole preview fails — `403 Forbidden … 9106 Missing X-Auth-Email
header`, then one `error serializing property "zoneId"` per record, and
  `1 errored` beside the unchanged count. `yarn preview` puts the token there;
  `yarn pulumi preview` does not.
- **A bare `preview` does not read the device.** It compares desired inputs
  against stored state. Drift on a host only surfaces under `pulumi refresh` or
  `preview --refresh`, so a deploy that wants to be sure of what it is changing
  passes `--refresh`. `tests/integration/run.sh` asserts both halves of this. The
  device is what it does not read: the zone lookup above happens either way.
- **`op` refuses a biometric prompt from a shell with no terminal session.** The
  1Password CLI answers `authorization prompt dismissed, please try again` when
  called from an agent's or a script's shell, and every `SealedEnv` read is an
  `op read` (`src/infra/vault.ts`) — so `yarn preview -s <host>` and
  `yarn deploy -s <host>` (both already `--refresh`) have to run from a terminal
  the desktop app can prompt. Both fail in the first second now rather than at
  the first resource: `scripts/pulumi.ts` warms the session and reads the
  Cloudflare token before it spawns the CLI. `yarn pulumi preview` (no refresh)
  touches neither the vault nor the device, and stops at the zone lookup instead
  unless `CLOUDFLARE_API_TOKEN` is already in the environment.
- **Pulumi in a non-interactive shell wants `--yes`.**
  `yarn deploy -s <host> --yes`; without it the CLI exits with "--yes or
  --skip-preview or --preview-only must be passed in to proceed when running in
  non-interactive mode" before doing anything.
- **`yarn up` is yarn's own command.** Yarn 4 resolves `up` to its
  dependency-upgrade command before it looks at `package.json`'s `scripts`, so
  the deploy script here is named `deploy`, and no script may be named after a
  yarn builtin (`up`, `add`, `remove`, `run`, `info`, `why`, ...).
- **ssh joins its arguments and the remote shell re-parses them.** A `>>` in a
  command string is applied by that shell as the login user, not passed to sudo.
  Pass content on stdin — which is what `RemoteFile` does, and why
  `assertSafePath` exists.
- **ssh exit 255 is the transport, never the command.** Every provider's `read`
  asks "does this exist" through a probe's exit status, and a refused session
  answered that question as "no" — on a refresh that is a live resource dropped
  from state, and the next `up` re-creating it. `run()` throws on 255 for that
  reason, and retries the two throttles a parallel deploy trips over a
  multiplexed connection: sshd's `MaxStartups` (reset during key exchange) and
  `MaxSessions` (`Session open refused by peer`); the image raises both. Neither
  retry reaches a resource already in state, though: a dynamic provider's code
  is serialised into each resource when it is created, and a refresh runs the
  copy the state holds, so a fix to `run()` applies to a resource only once
  something else updates it. What holds regardless is the client's own limit —
  `yarn deploy` and `yarn preview` pass `--parallel 4`, and a `SystemdUnit` read
  opens two sessions, so at most eight are ever open against sshd's default ten.
- **A resource the refresh forgot is re-adopted by an idempotent `create`, and
  the creates are idempotent on purpose.** `RemoteFile.create` writes the same
  bytes, `SealedEnv.create` re-seals to the same plaintext, `SecretFile.create`
  writes that ciphertext and re-runs the decrypt, `SystemdUnit.create` runs
  `daemon-reload` and `systemctl start`, which is a no-op on a running unit, and
  an `nftables.service` reload re-applies the same rules. So a state file that
  lost fifty resources is repaired by one `yarn deploy`, with no service
  restarted that the plan did not already restart. A new provider keeps that
  property: `create` on a device that already holds the resource must converge,
  never fail and never restart. What the refresh cannot repair is a resource the
  _program_ no longer declares — it is simply orphaned on the device (the two
  retired per-service port files were, and had to be removed by hand), so after
  any refresh that reported transport errors, list what the program stopped
  declaring and check the device for it.

## Migration status

`../raspi` is authoritative for anything not listed here. LAN DNS is keel's own,
a hosts file Pi-hole's entry derives from the catalog, and so is public DNS now
— a `cloudflare.DnsRecord` per `publicDns: true` vhost. Cloudflare
was the only resource both repos could touch, and `cloudflare_dns` left the old
repository's `DEPLOY` in this change, because its orphan reaper deleted any
LAN-pointing A record it did not know about — left running, it would have
reaped every record this repository now owns. Nothing here reaps in the other
direction: records the old repository made for services that no longer exist
are orphans nobody deletes. List them by hand once
(`GET /zones/{zone}/dns_records?type=A&content=<lanAddress>`), compare with the
catalog, and delete what the catalog no longer names.
