# keel

The core OS image for the Raspberry Pi fleet, plus the Pulumi layer that
configures what an image cannot.

Two halves, split by what each is good at:

- **The image** is the machine: packages, hardening, packet filter, podman
  networks, memory profiles, and Unbound — the one resolver that is a package
  rather than a container. A bootable container (`bootc`), shipped to a registry,
  applied with `bootc switch`. `/usr` is read-only, so OS drift is not a thing
  that happens, and `bootc rollback` undoes a bad boot. One artefact boots every
  board: it holds no address, no domain and no host name, and what makes a board
  a particular machine comes from [`keel.conf`](#keelconf) on its card.
- **Pulumi** owns the workloads and everything with an API to read back: the
  services on the device, their routes, their memory caps, the ports the packet
  filter admits to them, their encrypted secret blobs, and the nightly restic
  snapshot of everything they keep. Cloudflare DNS, the NetBird account, Kanidm
  OAuth2 clients, Beszel users and which image digest each host is booted into
  are planned — the providers for them do not exist yet.

The line between them is change frequency. An app service changes weekly and
`pulumi up` applies it in seconds; the machine changes rarely and costs a reboot.
Container images are deliberately on the Pulumi side of it — including Pi-hole's:
pinning them into the image would make a blocklist update an OS rebuild.

One `ServiceSpec` is the whole declaration of a service — the quadlet, the
systemd unit, the memory cap, the Traefik route, the ports the packet filter
admits, the DNS record, the OIDC client, the egress policy and the backup path
all derive from it, and the half that names your house comes from the entry's own
`setup(installation)`. Configuring a service is editing that one entry, plus
values in the single `INSTALLATION` object when it needs any: nothing to
register, no table to add a name to, no dispatch to extend. Dynamic providers do
the work, every one of them
implementing `read`: `RemoteFile` and `SystemdUnit` so `pulumi refresh` — or
`preview --refresh` — sees a hand-edited file or a stopped unit, `SecretFile` for
the sealed blob, and `ImageDigest` and `SealedEnv` so that resolving a moving tag
and reading the vault happen inside a resource rather than in the program. That
last part is what makes a preview free of side effects: it prompts for nothing
and reaches no registry. A bare `preview` compares desired inputs against stored
state and never consults the host, the vault or the registry; what `read` buys is
that a refresh has something to ask. Deleting a service is deleting its entry.

The predecessor, [`raspi`](../raspi), remains the live setup until a host has
been migrated. Nothing here touches a host the migration plan has not reached.

## Quickstart

**What you get**, on one Raspberry Pi and one domain:

- **LAN DNS with ad blocking** — Pi-hole answering :53, in front of a native
  Unbound recursor. The image brings Unbound up on its own, so a board resolves
  before anything is deployed to it.
- **A wildcard certificate** for `*.your.domain`, issued over **DNS-01**. Port 80
  is never opened: there is no HTTP challenge to answer and no redirect to serve.
- **SSO in front of every service** — Kanidm as the OIDC issuer, oauth2-proxy as
  the forward-auth gate Traefik asks before it routes anything. Every route also
  carries an IP allowlist admitting the LAN and the mesh, because an address is
  not an identity and neither replaces the other.
- **A password manager** — Vaultwarden, on its own vhost behind the gate. It is
  also where the passkey that logs you into Kanidm can live, if you have nowhere
  better to keep one.
- **Nightly restic snapshots** of everything those services hold, for a host that
  states `backup: true` — which the example host does not, because the backup
  wants an SMB share already standing and three vault fields of its own.
  `INSTALLATION.backup` is the share they land on, and the installation object
  asks for one whether or not a board uses it.

**What you supply**

- **A domain on Cloudflare.** The DNS-01 challenge is a Cloudflare API token,
  read from the vault. Another registrar means another `dnsChallenge` provider in
  `src/adapters/traefik.ts` and that provider's own credential.
- **A 1Password vault**, holding the fields each entry names — or the willingness
  to swap it out: every secret is read by `src/infra/vault.ts` at deploy time and
  sealed to the host, so replacing that one module replaces the vault. Which
  vault is the `vault` field of `installation.ts`; what has to be in it is the
  checklist below.
- **A value for every field of `installation.ts`**, including `backup`, which
  only a host stating `backup: true` uses — the object is one shape for the
  whole fleet rather than a per-host one, so the type asks for it either way and
  the example's value is a valid installation. Every field there is something
  the fleet or several services need; what one service of yours needs it states
  in its own entry in `services.local.ts`, which is gitignored too, so this file
  does not grow as your catalog does. See [Roadmap](#roadmap).
- **A login, if you want your own rather than the project's.** The image creates
  exactly one account, `ADMIN_USER` in `src/config/keel.ts` — `keel`, which your
  `KEEL_ADMIN_KEY` lines authorise and every `ssh` below logs in as. sshd admits
  the `wheel` group and no name, so that constant decides which account gets
  _created_, not who may log in: leave it and give the board an ssh_config entry
  carrying `User keel`, or set it to your own login before you build the first
  card. See [changing the admin account](#changing-the-admin-account).
- **A Raspberry Pi 3B, 3B+ or 4, and a card you can swap back.**
- **A machine to deploy from**, with node and yarn — `yarn install` pulls
  Pulumi's own CLI in as a devDependency, so there is nothing to install
  separately for it — plus the two binaries a deploy shells out to: `op`
  (1Password's CLI, unlocked by its desktop app) and `age`. Building a card on
  that machine as well wants more — see step 3.

**The steps**

```fish
git clone <this repo> keel && cd keel

# Every `yarn` in this file is the release vendored in .yarn/releases. A yarn on
# PATH — 1.x or corepack — delegates to that one; with no yarn at all, running it
# directly is the same command, and this is the invocation that always works.
node .yarn/releases/yarn-4.18.0.cjs install

# 1. The two installation-specific modules. Both, not one: a missing one is an
#    unresolved import rather than a default. installation.ts is your network,
#    your vault's name and your boards; services.local.ts is whatever you run on
#    top of the five keel ships with — its example holds one working entry,
#    `memos`, which step 5 would deploy, so replace it with your own or empty the
#    list. Both are gitignored; the examples are what CI builds from.
cp src/config/installation.example.ts src/config/installation.ts
cp src/config/services.local.example.ts src/config/services.local.ts
yarn validate

# 2. The passphrase every `pulumi` command in this file needs. The loader and
#    the state directory are `Pulumi.yaml`'s own — `nodeargs` and `backend.url`
#    — so the passphrase is the one thing left to supply, and `yarn pulumi`,
#    `yarn preview` and `yarn deploy` load it from `.env` for the command they run.
cp .env.example .env    # then fill in PULUMI_CONFIG_PASSPHRASE

# 3. A card. It writes your keel.conf onto the ESP itself, so the card that
#    reaches Etcher already answers to that host — at the cost of a local image
#    build: podman, qemu-system-aarch64, sfdisk and jq. Flashing the published
#    image and dropping a keel.conf onto its ESP by hand is the same mechanism
#    without the toolchain.
image/card.sh <host>

# 4. Once the board is up — at whatever address your router hands it, or an
#    ssh_config Host entry naming that address — an identity for it, and its
#    public half into the host's entry in installation.ts as `ageRecipient`.
#    The account is the one keel-firstboot created: ADMIN_USER from
#    src/config/keel.ts, which is not your local username unless you made it
#    so. Name it here, or as `User` in that Host entry, and the rest of this
#    file's bare `ssh <host>` works.
ssh <admin>@<host> "age-keygen | sudo install -D -m 600 /dev/stdin /etc/keel/age.key"
ssh <admin>@<host> sudo age-keygen -y /etc/keel/age.key

# 5. Everything the host runs, in dependency order — the resolver,
#    the proxy behind it, the certificate its reader waits for, the issuer, the
#    gate. This run stops at the one vault field that cannot exist yet: the
#    gate's OIDC client secret is issued by a *running* Kanidm, which this run is
#    what brings up.
yarn pulumi stack init <host>
yarn deploy -s <host>
# register oauth2-proxy as a client with Kanidm's own CLI, and put the secret it
# prints into the vault as kanidm/oauth2_proxy_client_secret
yarn deploy -s <host>
```

**The vault items.** Nothing creates them for you. Each field is read by the
resource that seals it, as the service that needs it is deployed — so a missing
one fails that service and whatever waits on it, naming `item/field` and what
would have been deployed blank, while the services ahead of it in the graph are
already on the device. Checking the whole list in the program body instead would
put a vault read where it fires on every `pulumi preview`, which is the side
effect the layer is arranged to keep out. One row per field the example catalog
reads, in the vault `installation.ts` names:

| Field                               | What reads it                                                    |
| ----------------------------------- | ---------------------------------------------------------------- |
| `cloudflare/password`               | Traefik, as the DNS-01 token for the wildcard certificate        |
| `oauth2-proxy/cookie_secret`        | The gate's session cookie — 32 random bytes, base64              |
| `kanidm/oauth2_proxy_client_secret` | The gate's OIDC client secret, the one Kanidm issues on register |
| `vaultwarden/admin_token`           | Vaultwarden's admin page                                         |
| `vaultwarden/smtp_email`            | The relay login, which is also the From address                  |
| `vaultwarden/smtp_password`         | That login's password                                            |

A host that states `backup: true` reads three more — `restic/password`
for the repository, and `cifs/readwrite_username` with `cifs/readwrite_password`
for the share — which is why the example host does not: a first deploy
should not need a share to exist. A host that mounts one of `INSTALLATION.shares`
reads the other pair on the same item, `cifs/readonly_username` and
`cifs/readonly_password`, because a share declared `readOnly` authenticates as
the account that cannot write to it. `yarn spec <name>` prints the `item/field`
behind every secret variable an entry reads — names only, since it never opens
the vault — so the row for any entry, this table's or your own, is one command
away rather than something to work out from the source.

**Why step 5 is two runs.** Every field in that table but one is yours to write
into the vault before you start. `kanidm/oauth2_proxy_client_secret` is the one
that cannot exist yet: Kanidm issues it when the gate is registered as a client of
it. So the first run stops on the gate: the read of that field fails by name.
Register the client against Kanidm, put the secret in the vault, and the second
run finishes. Nothing is staged by hand: the host's entry says what it runs —
the whole catalog unless it lists a subset — and the graph says in what order.

How much of the fleet is standing when it stops is not guaranteed, and it does
not need to be. `pulumi up` halts on the first error, and the gate's vault read
is a resource of its own rather than a child of its service — so it can fail
before the services it would have gated are converged. The second run picks up
from wherever the first stopped, which is what a declarative apply is for.

That the run gets that far is a property, not luck. **A sealed environment is
ordered behind the same services the container it belongs to is**, so the gate's
vault read happens after Kanidm is running rather than in the run's first
seconds. Ordered like any other root it would fail immediately — and Pulumi stops
an update at the first error, so it would take down the very run that was going
to make the field answerable.

**What starts after what.** Two edges are derived from declarations an entry
already makes — a service that runs an OIDC client of its own starts after the
identity provider whose discovery document it fetches, and a service that reads a
certificate out of the proxy's store starts after that proxy. Everything else an
entry writes down as `dependsOn`, which is ordering and never selection: the
proxy is started after the resolver, so its DNS-01 challenge resolves the
registrar's API through the LAN's own resolver rather than through the public
fallbacks `resolv.conf` keeps for the gap before that resolver is up — a
preference, not a precondition, since those fallbacks answer either way. A name
the host's `services` list leaves out stops the plan rather than quietly pulling
the entry in; so does a name no entry is called, and a cycle, which is reported
as the loop. Deliberately absent is "a vhost depends on the proxy" — a route
file needs nothing running to be written, and the rule would close a loop
through the resolver's own vhost.

A board with nothing on it therefore comes up in one command. Each core
service's start job means it is _answering_ and not merely running: the
resolver's check is a non-recursive query for its own name, the proxy's is
`traefik healthcheck` against its ping endpoint, and Kanidm's is a TLS
handshake. Between them, the one-shot that copies the wildcard out of
`acme.json` **waits** for one to appear rather than reporting that it has not,
because the proxy answers minutes before the DNS-01 challenge finishes. So a
certificate that never arrives fails the run by name instead of leaving a crash
loop behind a `systemctl start` that returned success.

See [flashing a card](#flashing-a-card-and-bringing-a-host-up) for the whole of
steps 2 to 5 at length: what `card.sh` does, why the state lives where it does,
and what to look at when a board does not come up.

**What is not there yet.** Three things are still manual, and none of them is
hidden by a resource that pretends otherwise:

- **DNS records.** The vhost names have to resolve to the board's LAN address;
  create the records at your registrar by hand. Pulumi does not manage Cloudflare
  yet.
- **OAuth2 clients in Kanidm.** Register `oauth2-proxy` as a client with Kanidm's
  own CLI and put the secret it generates into the vault, where the gate's entry
  reads it. Nothing registers it for you, which is what makes step 5 two passes —
  and the same is true of every service that runs a client of its own, so an
  `auth: "oidc"` entry needs the registration before its first login.
- **Monitoring.** Nothing watches the fleet.

See [Roadmap](#roadmap).

### Adding an application of your own

A service is one entry in `services.local.ts`. For an application you built
yourself, most of that entry is the same as the last one you added: one loopback
port, one SQLite file, a vhost, a login. The template in
`src/config/templates/houseApp.ts` is that shape as a constructor, so the entry is
the facts that actually differ:

```ts
// at the top of the file, beside the `ServiceSpec` type import
import { houseApp } from "./templates/houseApp";

// and in LOCAL_SERVICES, in place of a literal entry
houseApp({
  name: "atlas",
  description: "The next thing you build — one image, one port, one database",
  image: "ghcr.io/you/atlas:main",
  port: 3010,
  memory: { max: 96, measuredMb: 30 },
  auth: "edge",
  // Whatever your application actually reads these out of. Nothing here is
  // derived, because these names are your application's and not this fleet's.
  env: { ATLAS_LISTEN: "0.0.0.0:3010", ATLAS_DB: "/data/atlas.db" },
}),
```

That expands to the entry somebody would otherwise have written by hand:

- **`atlas.<your domain>`**, in public DNS, routed by the proxy behind the same
  IP allowlist as every other vhost, and — because `auth` is `edge` — behind the
  forward-auth gate, which is the whole login.
- **`/var/lib/atlas` mounted at `/data`** with `:Z,U`, since the image runs as
  uid 1000 and the unit makes the directory as root — and in the nightly snapshot,
  because that directory is the whole of what a restore brings back.
- **`SESSION_KEY`** from `atlas/session_key`, the key the application signs its
  own cookie with once the gate has said who is calling.
- **The internal bridge**, its port published to the host's loopback where the
  proxy dials it, and no route off the host at all.
- **The application tier**, and a tag rather than a digest for an image whose
  own CI pushes `main` — the deploy resolves it to a digest when it runs, so the
  diff is still a digest change.

**What it does not derive is your application's own vocabulary.** The variable it
reads a listen address or a database path out of is a name only your application
knows — a `<NAME>_BIND` rule would be right for two of the five applications this
shape was written for and wrong, silently, for the other three: the application
falls back to its own default and writes its database somewhere the nightly
snapshot does not cover. So `env` is yours alone, passed through with nothing
added, renamed or read. What the bind should say is your application's contract
too, and there is one fact about the deployment to know when writing it:
`0.0.0.0:<port>` inside a bridge namespace, where loopback is the container
talking to itself and the published port forwards into nothing;
`127.0.0.1:<port>` under host networking, where no published port narrows the
bind and a wildcard puts the service on the board's LAN address. A bind that
gets this wrong fails where it is seen — the proxy dials the port and gets no
answer at the first request — which is why it is a sentence here and not a check.

Anything else on a `ServiceSpec` is an override: `subdomain`, `publicDns`,
`egress`, `backup`, `cmd`, `healthCmd`, `vaultItem`, `dependsOn`, `ingress` and
the rest replace what would have been derived, while `env`, `secretEnv`,
`mounts` and `setup` merge with it — and a variable or a mount claimed by both is
an error naming it, because neither side winning silently is a rule anybody
would want.

**An application that runs its own OIDC client** states `auth: "oidc"` and the
vault item the identity provider keeps its generated secrets on
(`identityItem: "kanidm"`). That adds **`OIDC_CLIENT_SECRET`** from
`kanidm/atlas_client_secret` — the provider's item, because the provider generates
that secret and keeps it with its own credentials, so register the client with
Kanidm and write the secret into the vault before deploying, exactly as with the
gate — plus **`OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_REDIRECT_URL`**, composed
from the deployed provider's vhost and this entry's own so that no URL and no zone
is written down anywhere.

It also moves the application onto **the host's network stack** — so the entry
states `127.0.0.1:3010` as its bind, there being no published port to narrow a
wildcard — and the template refuses any other network for it. The application
makes half the login itself — discovery, the token exchange, the JWKS fetch —
against the issuer's own vhost, and every route's allowlist admits the LAN and
the mesh while the packet filter admits `:443` from those same two sets. The
host's address is in both; a bridge address is in neither, and the internal
bridge has no route off the host at all, so a client on a bridge deploys clean
and fails at its first login. That is why the gate runs this way.

**Know what the host's stack costs before choosing it.** It is not only egress to
the internet: the host's namespace is where every service's loopback upstream
lives, so such an application can dial Kanidm's port, Vaultwarden's, the gate's
forward-auth endpoint and every other application's directly — past each route's
IP allowlist and past the gate, none of which is in the way of a caller that never
goes through the proxy. On the internal bridge it can reach none of them, and
nothing in the packet filter changes that either way, because a namespace is not a
hop. So `auth: "edge"` is what an application arrives on, and `auth: "oidc"` is
for one whose own login is worth trusting it with the board's loopback.

```fish
yarn spec atlas       # the whole expansion, as JSON
yarn spec atlas --profile 8g | jq -r .quadlet.body
```

`yarn spec <name>` works on any entry, stamped or literal: it prints the quadlet,
the route, the caps for a profile, the mounts, the backup path, and the
`item/field` behind every secret variable — names only, because it never opens the
vault. That command is what makes six lines readable rather than opaque.

**When to write the entry out instead.** Every convention above has an opt-out —
`dataDir` and `subdomain` are nullable, and the rest are plain overrides — and
needing more than two of them means the entry is not this shape: a stamp plus a
list of exceptions reads worse than the thirty lines it saved. Somebody else's
product is a literal entry from the first line, because a released image is
digest-pinned rather than a tag its own CI moves, keeps its data where it
chooses, and signs no session with a key from a vault item named after it. A
native service, a bundle of units that need each other, or a product configured
through its own REST API are out of scope by construction; the module's own doc
comment says why.

Leaving the template costs nothing downstream, because it returns a plain
`ServiceSpec`: the catalog holds the result, so writing an entry out is a change
to that entry and to nothing else. It is a translation by hand, though, not a
paste — `yarn spec` prints an entry _resolved_, which is a report rather than a
spec literal: the two URLs the setup composed arrive merged into the environment,
and a literal entry composes them from the identity role instead of writing a zone
into a catalog. `tests/houseApp.test.ts` holds one stamp's literal equivalent
spelled out, which is the shape to copy.

## Layout

| Path                    | What it is                                                                     |
| ----------------------- | ------------------------------------------------------------------------------ |
| `src/config/keel.ts`    | The machine itself — packages, hardening, the packet filter's shape. Committed |
| `src/config/`           | Pure data — the service catalogs, what a service declaration is, the profiles  |
| `src/config/templates/` | Constructors for a shape several entries share, returning a plain spec         |
| `src/adapters/`         | One module per product whose dialect this repo speaks — the proxy, the gate    |
| `src/render/`           | Pure functions from config to a file tree. No I/O                              |
| `src/cli/render.ts`     | Writes the image tree to `build/root/`                                         |
| `src/cli/spec.ts`       | Prints one entry as it resolves — `yarn spec <name>`                           |
| `src/infra/`            | The Pulumi program                                                             |
| `image/`                | `Containerfile`, `build.sh`, `test.sh`                                         |
| `scripts/`              | One-off maintenance scripts, e.g. `pin-image.sh`                               |
| `tests/`                | The rendered tree as a golden, and the rules a reader needs stated             |
| `tests/integration/`    | Boots the image under podman and drives the device providers against it        |

Two modules under `src/config/` are gitignored, because they belong to one
installation rather than to the fleet. Copy the `.example.ts` counterpart of each
and fill it in:

| Gitignored          | What it holds                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installation.ts`   | One `INSTALLATION` object — the vault's name, network, mesh, mail, backup, shares, and the boards: per host its RAM, age recipient, admin keys, and the services it runs if not all |
| `services.local.ts` | The services this installation runs on top of the five in `services.ts`                                                                                                             |

`src/config/services.ts` is the committed **example catalog** — traefik, kanidm,
oauth2-proxy, pihole, vaultwarden — and it is what keel is: the resolver, the
certificate, the login and the vault. `SERVICES`, which every consumer iterates,
is that list with the local one appended, and nothing downstream can tell the two
apart. A personal service in the example catalog would publish what one house runs
and be wrong for every other clone, so it goes in the local one; a test holds the
example half to naming no address but loopback, nothing from the installation, and
no moving image tag.

`src/config/keel.ts` is committed, because it is what the image renders from and
an artefact everyone boots should be readable in the repository that builds it. A
renderer reads it together with `profiles.ts`, the catalogs and `versions.ts`, and
never `installation.ts` — a test asserts that, because one installation baked
into an artefact meant for every board is the whole failure this split prevents.
`profiles.ts` pricing every catalog entry is also why even the image render wants
`services.local.ts` on disk: the slice budgets are the sum of the core tier's
caps, so a render needs a catalog even though no service reaches the tree. That
makes the local catalog the one piece of installation config the render path does
import, and the import scan is not what keeps the tree independent of it —
arithmetic is. The core tier is the resolver, the proxy and the identity
provider, all committed, and a test prices the budgets from the example catalog
alone: a local entry claiming that tier fails `yarn validate` rather than quietly
changing the artefact CI builds.

The rule that keeps this small: **render, never hand-author.** Adding a service
is editing one catalog entry; the quadlet, the unit, the cap, the router, the DNS
name and the firewall rule all fall out of it. Because
rendering is a pure function, the invariants that used to live in prose are
tests that run in milliseconds — including the one that holds the whole tree to
naming no address, no domain and no host, and the one that refuses any module
outside the catalog that names two services or branches on one's name.

## Build and test

```fish
# The two installation modules go in first — quickstart step 1. Without them
# `validate` is two unresolved imports rather than a test result.
node .yarn/releases/yarn-4.18.0.cjs install
yarn validate                 # typecheck + lint + format + render tests
yarn render                   # config -> build/root/
image/build.sh                # render + podman build --arch arm64, tagged keel:latest
image/test.sh keel:latest     # bootc lint, unit syntax, generator profiles
```

Five tiers, cheapest first. Tiers 1–4 need no Pi:

1. **Render tests** (`yarn test`) — the rendered tree as a golden, byte for byte
   and mode included, beside the rules a reader needs stated: port collisions,
   memory budgets, a packet filter that admits nothing until it is told to, no
   address or host name anywhere in the tree, no key material in it.
2. **Image tests** (`image/test.sh`) — a bootc image is an ordinary OCI image, so
   `bootc container lint`, `systemd-analyze verify`, `sshd -t` and `nft --check`
   all run in a container.
3. **Device-provider integration** (`yarn test:integration`) — boots the image
   under podman with systemd as pid 1 and drives `RemoteFile` and `SystemdUnit`
   through their full lifecycle against it: create, read, diff, update, drift
   detection, delete.
4. **Boot test** — `bootc-image-builder` to qcow2, boot under QEMU aarch64.
5. **Hardware** — a real board, on a card you can swap back.

The first tier is two kinds of test, and the distinction is what keeps it short.
`tests/image.test.ts` pins every file the image carries, with its mode, so a
change to any of them is a diff somebody reads — and a diff there is a new image
digest and a reboot on every board, which is what makes it worth reading. Every
other test states a rule: why a file says what it says, what the board would be
silently wrong about if it regressed. A test that only repeats a line the
renderer wrote is not one of those, because the golden already holds the line.
The two service goldens work the same way — `golden.test.ts` for the committed
catalog, the gitignored `golden.local.test.ts` for yours — and a change to a live
service's body is a container restart, so reading that diff is the review. Run
them under `CI=true` when the point is that nothing changed: outside CI, vitest
writes a snapshot it has not seen before instead of failing on it, so a renamed
path or a new file would pass the run that should have asked about it.

## keel.conf

The image knows nothing about the network it is plugged into, so a card carries
a `keel.conf` at the root of its ESP — the FAT partition any laptop mounts:

```ini
KEEL_HOSTNAME=raspi
KEEL_ADMIN_KEY=ssh-ed25519 AAAAC3Nza... you@yours
KEEL_LAN_CIDR=192.168.1.0/24
KEEL_MESH_V4=100.92.0.0/16
KEEL_MESH_V6=fd2b:9e41:7c05::/64
```

Five keys, all optional, `KEEL_ADMIN_KEY` repeatable — one line per key admitted
to the admin account, which is the account `keel-firstboot` creates and puts in
`wheel` on this same pass. `KEEL_HOSTNAME` names the machine; the three ranges
become elements of the `lan4`, `mesh4` and `mesh6` sets the packet filter matches
against, written to `/etc/keel/nft.d/10-ranges.nft` before nftables loads. A file
with only some of them applies what it has.

`keel-firstboot.service` reads it on **every** boot and converges: it compares
before it writes, so a steady-state boot changes nothing under `/etc`, and
fixing a typo is editing the card and rebooting. Moving a card to another board
makes that board the host the card describes. A card with no `keel.conf` leaves
the unit successful and the board unconfigured: the script says so in the journal
and exits 0, because a machine nobody has given an identity to is not a broken
one — which is why the selftest reports it as an advisory and greenboot never
rolls an image back for it.

The file is parsed, never sourced: it is removable media, every value is checked
against a pattern before it is used, and an unrecognised key is a line in the
journal.

`yarn card-config <host>` prints the file for one of the boards in
`installation.ts` — the key is the hostname, `adminKeys` the key lines, the
network and mesh blocks the ranges — which is what `image/card.sh` writes onto
the ESP of the card it builds.

### Changing the admin account

`ADMIN_USER` in `src/config/keel.ts` is the account `keel-firstboot` creates and
adds to `wheel`. Nothing matches on the name — sshd's `AllowGroups wheel` and the
`%wheel` sudoers drop-in match the group — so that constant decides which account
comes into existence, not who may log in. Which is what makes changing it safe
from the ssh session you are holding: an account already in `wheel` keeps working
while the new one appears beside it, so no boot leaves the board with nobody able
to reach it. The same sequence serves a stranger adopting their own login and an
owner retiring a personal one:

1. `ssh <host> id -nG` — the account you are holding has to list `wheel`, since
   that group is what carries both ssh and sudo on the image below. Coming from
   one that admitted a name instead, the two move onto the group at the same
   reboot, so an account outside it loses them together, and
   `sudo usermod -aG wheel <old>` first is what keeps the rest reversible.
2. Edit that line, then build and publish the image.
3. `bootc switch` and reboot the board, or flash a fresh card.
4. `ssh <new>@<host> sudo -n id` — both halves in one command: sshd admitted the
   account on its group, and the drop-in grants it root with no password, which
   is the form every device resource arrives in (`ssh <alias> sudo …`). Asked
   rather than assumed, because that drop-in lives under `/etc`, where bootc
   3-way merges — a copy edited on the board survives the switch, so a board
   still carrying a per-account line gives the new login ssh and no sudo.
5. Point the board's ssh_config entry at it, by changing `User`.
6. `sudo userdel -r <old>`, for the account you arrived as.

The last step is by hand and deliberately last: both accounts are in `wheel`
until it runs, so nothing depends on the new one before you have used it — and
steps 1 and 4 are the two premises whose failure that step would make permanent.

What the group does not rescue is a board that never had a member: a card with no
`keel.conf` gets no account created, because `keel-firstboot` is the only thing
that creates one, and `AllowGroups wheel` then admits whoever is in `wheel`,
which is nobody. Neither does a keyboard and a screen: no account in the image
has a usable password, so the login prompt cannot be answered and systemd's
emergency shell refuses a locked root. The way in is the card — mount its ESP on
any laptop, write the `keel.conf` above, boot it again — or the bootloader, whose
prompt is not password-protected and takes kernel arguments.

## Flashing a card and bringing a host up

```fish
image/card.sh raspi   # build, shrink, inject Pi UEFI, sideload keel.conf, boot what it built
```

The card this produces boots a Raspberry Pi 3B, 3B+ or 4. It also carries a Pi
5 dtb and should boot a 5, but that path is untested on real hardware — nobody
in the fleet has one yet.

`card.sh` builds the image before it writes a card, so it wants podman (with
`--privileged`, for bootc-image-builder), `qemu-system-aarch64` for the boot test,
plus `sfdisk` and `jq`. On a machine that is not an arm64 one the `podman build
--arch arm64` is emulated and slow. `KEEL_QEMU_FIRMWARE` points at the directory
holding `edk2-aarch64-code.fd`, which defaults to Homebrew's — set it on Linux.
Nothing about this is required to bring a host up: the published image plus a
hand-written `keel.conf` is the same card.

The result is `build/card/image/disk.raw`, around 2.3 GB written — small on
purpose, because flashing is the slow step, and `keel-growfs` claims the rest of
the card on first boot. `card.sh` writes `raspi`'s `keel.conf` — its hostname,
its admin keys, the LAN and mesh ranges — onto the card's ESP itself, so the
card Etcher writes already answers to that host. Etcher writes it. `card.sh`
boots the finished artefact before handing it over, so a card that reaches
Etcher has already reached a login prompt once.

A card can also be given an identity by hand, which is the same mechanism
without the script: flash the bare image — the one artefact every board
boots — then mount its ESP, the FAT partition any OS opens with no special
tooling, and drop a `keel.conf` onto it (see [`keel.conf`](#keelconf) for the
file format). That is also how a card already in a board is reassigned: pull
it, edit the file, put it back.

The image is deliberately bare: it boots, hardens itself, brings up Unbound and
answers ssh. Everything else arrives over Pulumi.

State is self-managed and lives in the gitignored `state/` directory beside the
repo, carried between the admin's machines by Syncthing (`.stignore` whitelists
it together with the private config files, so one Syncthing folder moves
everything a deploy needs). It holds no secret values — that is what sealing to
the host's identity buys — so the passphrase protects stack config and nothing
else. The loader and the state directory are `Pulumi.yaml`'s own — `nodeargs`
and `backend.url` — so the passphrase is the one variable a deploy needs, and it
lives in `.env` (gitignored, Syncthing-carried; copy `.env.example` and fill it
in once). `yarn pulumi`, `yarn preview` and `yarn deploy` load it for the command
they run:

```fish
yarn pulumi stack init raspi        # once
```

The passphrase can stay out of `.env` — leave the line empty there and export it
per session instead; `dotenv-cli` never overrides a variable already set, only
one that is missing:

```fish
set -x PULUMI_CONFIG_PASSPHRASE (op read op://<your vault>/keel/password)
```

Syncthing is what makes the state portable, and it is also the constraint: run
`pulumi` from one machine at a time and let the folder sync before switching —
Pulumi's lock file protects against concurrent runs on one machine, not against
two machines racing a sync. A `*.sync-conflict-*` file inside `state/` means
that race happened; keep the newer checkpoint and diff the loser before
deleting it.

An SMB share is not a viable home for this state: macOS writes an AppleDouble
`._*` sidecar for every file it creates on plain Samba (the
`com.apple.provenance` xattr), and Pulumi trips over them
(`invalid character '\x00'`) — including on the lock file `pulumi up` writes
for itself. Only server-side `vfs_fruit` avoids that, which consumer routers'
USB shares do not offer.

```fish
# 1. The board answers on the address the router pins to its MAC, as the one
#    account keel-firstboot made: ADMIN_USER from src/config/keel.ts. Every bare
#    `ssh raspi` here assumes an ssh_config Host entry carrying that address and
#    that `User`.
ssh raspi

# 2. An identity for the host. The private half never leaves it; record the
#    public half as `ageRecipient` on the host's entry in src/config/installation.ts.
ssh raspi "age-keygen | sudo install -D -m 600 /dev/stdin /etc/keel/age.key"
ssh raspi sudo age-keygen -y /etc/keel/age.key

# 3. Everything the host runs, in dependency order. On a fresh
#    installation this stops on the gate's sealed environment: the OAuth2 client
#    secret is issued by a running Kanidm, which this run is what brings up.
yarn pulumi stack select raspi
yarn deploy -s raspi

# 4. Register oauth2-proxy as a client of that Kanidm, put the secret it prints
#    into the vault as kanidm/oauth2_proxy_client_secret, and finish.
yarn deploy -s raspi
```

There is nothing to stage: the host's entry is the whole selector — the catalog,
or the `services` it lists — and the order services are brought up in is the
graph the catalog declares — the resolver, then the proxy whose challenge
resolves through it, then the certificate its reader waits for, then the issuer,
then the gate that asks the issuer. Everything the LAN needs of this board
therefore arrives in one command rather than in a sequence somebody has to know.

If the board does not come up, put the card back in this machine: the ESP is FAT
and mounts anywhere, and `keel-boot.log` on it carries the journal, the failed
units and the selftest output. `keel-boot.prev.log` is the boot before, which is
the one that matters if the board is looping.

## Dependency updates

[Renovate](https://docs.renovatebot.com/) runs self-hosted, on its own weekly
schedule (`.github/workflows/renovate.yml`, Monday) — ahead of the image
workflow's own Wednesday build, so a bump has time to merge before that week's
image is built. It covers the Fedora base image and app-service digests
(`renovate.json5`'s `dockerfile` and custom managers), GitHub Actions pins, and
`package.json`'s devDependencies, including the vendored yarn release itself.
Automerge is off: every PR is a normal PR, and `validate` — the same render
tests `yarn validate` runs locally — gates it in CI like any other change.

It authenticates as `RENOVATE_TOKEN`, a classic PAT with the `repo` scope (or a
fine-grained PAT scoped to this repository with contents and pull-requests
read/write), set as a repository Actions secret. Renovate's own token, not
`GITHUB_TOKEN`: a PR opened by the built-in token cannot trigger this repo's own
workflows, which would leave `validate` never running against it.

## Updating a host

The first card is written by hand; after that the board updates itself over the
network, which is the reason for building the OS as an image at all.

CI builds on native aarch64, runs the image checks, and pushes the one generic
image to `ghcr.io/<owner>/keel`, as `:latest` and as `:sha-<commit>` for a
pin. The build needs no installation config: the image renders from what is
committed, so what CI produces is the artefact on the bench, for every host.

**The package is public.** Nothing in the image requires otherwise — it holds no
secret, no address and no host name — so there is no pull credential to put on a
device: `bootc switch` and the update timer below both reach the registry
anonymously.

Point a host at the registry once — the same image reference for every host,
because there is only the one image:

```fish
ssh raspi sudo bootc switch ghcr.io/<owner>/keel:latest
```

From then on the board updates itself: `bootc-fetch-apply-updates.timer` — the
unit bootc itself ships, with a drop-in this repo renders — fires once a week,
in a window randomised per host so the fleet does not reboot in the same minute.
That timer is the steady state; `bootc upgrade --apply` stays the immediate path
for whenever a fix should not wait for the window:

```fish
ssh raspi sudo bootc upgrade --apply
```

Either way, the new image is staged beside the running one and the board reboots
into it. If it comes up badly, greenboot rolls back on its own; `bootc rollback`
does it by hand. A rollback does not blocklist the digest it rolled back from —
the timer stages that same digest again at the next window — so the fix for a
bad image is publishing a good one before then, not racing the timer.

**A deploy that needs something new from `/usr` goes second.** Almost everything
Pulumi applies runs against any image, and the two halves can be deployed in
either order. A host's first CIFS share is the exception: the mount unit's
`credentials=` is `mount.cifs`'s option, and the helper is image content. Nothing
rejects the option without it — util-linux mounts through the kernel, which
ignores the options it does not implement — so the share would come up with no
login: an authentication failure against a server that wants one, and a silent
unauthenticated mount against a server that allows guests. A server that refuses
guests would fail the deploy for you, loudly, which is the case here — but that
would be the server making it true rather than the deploy. So the deploy asks
first: a `RemoteBinary` probe ordered ahead of the mount unit `test -x`es the
helper on the host and fails by name, on `up` and on `refresh` alike. The run
stops before systemd is handed a mount that would have had no login. So: update
and reboot the host, then `yarn deploy`.

## Memory profiles

One image, any board. `src/config/profiles.ts` defines profiles (`1g`, `4g`,
`8g`) and the arithmetic that prices a cap against one; the caps themselves are a
`memory` block on each catalog entry, beside the workload they are a claim about.
Each layer applies the profile to what it owns. The image stages the slice
budgets and the cap for Unbound — the one service with no entry to carry it —
picking a profile from `MemTotal` at boot; `keel.mem_profile=4g` on the kernel
command line overrides that. Pulumi caps the services it deploys, selecting the
profile from the board's `ramMb` in `src/config/installation.ts` and writing the
drop-in under `/etc/systemd/system/<name>.service.d/` beside the quadlet — which
outranks anything the image stages, so exactly one mechanism sets a service's
numbers.

Two slices carry the policy: `keel-core.slice` (resolver, proxy, identity) is
protected from reclaim and systemd-oomd never targets it; `keel-apps.slice` is
where pressure is resolved, throttled at whatever the board has left once the
core tier and the kernel's reserve are accounted for. `MemoryHigh` is
overcommitted on purpose — these are idle Go and Rust binaries and they are never
all hot at once — while the core tier's hard caps are held inside a budget the
tests assert on every profile.

## Secrets

Secrets never enter the image, and never enter Pulumi state. Pulumi writes
`/etc/secrets/<svc>.env.age`; the age identity that opens it lives only on the
host. `keel-secrets.service` decrypts at boot and the quadlet reads the result
through `EnvironmentFile=`, so no secret value is ever a resource input — the
state file holds a blob it cannot read. The vault stays the source of truth, and
`RemoteFile` refuses to write anything under `/etc/secrets` at all, so a file
whose content would land in state cannot be put where secrets live.

Rotating a secret is **`yarn deploy -s <host>`**. What the state knows is the item
and the field names, and those do not change when the value does; asking
1Password what the value is now is the `SealedEnv` resource's `read`, and `read`
is what a refresh calls. The rotated value then flows through as one run: a new
hash, a new blob, a decrypt on the host, and a restart of the service that reads
it. A refresh prompts for Touch ID, as a deploy does; a bare `preview` does not.

```fish
yarn deploy -s <host>
```

## Backups

What is backed up is derived, not listed: every `SERVICES` entry with
`backup: true` contributes its `/var/lib/<name>`, and a service's own
`backupExclude` patterns come with it. The set lands in `/etc/keel/backup.json`,
which is the only thing the script reads — so adding a service to the backup is
setting one field on its catalog entry, and a path that does not exist yet
(a service the host has not been given) is skipped at run time.

Where it goes is `INSTALLATION.backup` in `src/config/installation.ts`: an SMB
share, and a directory in it holding a restic repository. The repository
password and the share's login are vault fields sealed to the host like any other
secret — the `restic` item's password, and the `cifs` item's read-write pair.

Which boards do it is `backup: true` on the host's entry in
`src/config/installation.ts`. The example host leaves it off: the backup deploys
something no catalog entry declares, and a share that does not exist yet turns a
first deploy into three missing vault fields and a timer failing at 04:00.

Two timers, both Pulumi-enabled units: `keel-backup.timer` daily at 04:00 with
30 minutes of jitter, and `keel-prune.timer` on Sunday at 04:30. Both are
`Persistent=true`, so a board that was off runs the missed window at the next
boot. A run that fails leaves a failed unit, which is what the selftest and the
flight recorder report.

Neither restic nor `mount.cifs` has to be on the machine. The share is mounted by
calling `mount(2)` directly — the helper only ever translated a credentials file
into option bytes, and doing it in-process is also what keeps the password out of
every argv — and restic runs from a digest-pinned container with the repository
and the backed-up paths bind-mounted in at their real paths. The image installs
both packages as well, so a restore can be driven from an ssh session on a host
whose services are down, but nothing in the mechanism waits for that.

That independence is the backup's alone. A share a service depends on is a real
`.mount` unit — so that the service can be ordered after it and `systemctl stop`
can unmount it — and a unit cannot read a credentials file by itself, which is
what makes `mount.cifs` a prerequisite there and not here.

**Restores are manual.** The pyinfra repo's restore-on-blank — detect an empty
Pi at plan time, prompt, write straight into `/` — is deliberately not ported.
What exists is a pass-through: the same mount, the same unmount, restic's own
arguments.

```fish
ssh raspi sudo python3 /etc/keel/backup.py run snapshots
ssh raspi sudo python3 /etc/keel/backup.py run restore latest --include /var/lib/vaultwarden --target /var/tmp/keel-restore
```

The backed-up paths are mounted read-only for the manual path exactly as they are
for a scheduled run, so a restore cannot land on top of a running service: it
writes into `/var/tmp/keel-restore` and the operator moves what they came for.

Retention is 7 daily, 4 weekly and 6 monthly, applied per `host,paths` group,
which is restic's default and is chosen deliberately. Changing the backup set
starts a new group, and the previous group's snapshots then sit outside every
future retention run — a stale ladder per change, which grows visibly and can be
retired by hand. The alternative, `--group-by host`, is a footgun on a repository
with history in it: every snapshot the machine ever took falls into one 7/4/6
window, and the first run forgets the rest.

## Roadmap

**Monitoring**, and it is a piece of work rather than a service to add. What the
fleet needs is a way to know it is alright: status checks on the units that matter,
resource and disk trend over time, and alerting that reaches somebody when a check
fails — including when the board that would have sent the alert is the one that is
down. Beszel is part of the answer, but mainly as the status check; the alerting
path, what is checked, and where a failure lands are the design, and dropping an
agent into the catalog decides none of it. One structural gap belongs to the same
work: multi-host is modelled throughout — one stack per host, a profile per
board's RAM, a service list per host — but exercised by one host, which is the
classic way a second one turns out to be a rewrite.

**OIDC client registration.** Registering `oauth2-proxy` with Kanidm is manual
today, which makes the login the one part of a fresh install that a `pulumi up`
does not bring up. What is missing is a dynamic provider with a `read` that asks
the issuer what the client currently looks like, and the generated secret landing
in the vault where the gate's entry already reads it. What it needs of the
identity role — the provider's REST root, the administrative account and the vault
field holding its password, named and never valued — it states on `IdentityRole`
when it lands, so the role carries what has a reader and nothing ahead of one.

**Cloudflare DNS records.** Every vhost's name is created by hand. A record is
derived from an entry that already declares `subdomain` and `publicDns`, so this
is a provider and a resource rather than a decision. It has to land in the same
change that removes `cloudflare_dns` from the old repo's `DEPLOY`: that repo's
orphan reaper deletes any LAN-pointing A record it does not know about.

**An installation object whose halves are optional.** `Installation` no longer
grows with the catalog — a field there is what the fleet or several services need,
and what one service needs is stated on that service's entry — but it is still
asked for in full: a fleet that backs nothing up points `backup` at a share
anyway, and one with no NAS declares an empty `shares`. The remaining fix is a
host's `backup` flag and the shares its services bind deciding which blocks are
required, so a board that states neither is not asked for either.

**A second proxy or identity provider.** The roles are the claim that the products
are replaceable — `ProxyRole`, `IdentityRole` and `GateRole` exist so that no entry
outside an adapter spells a proxy-shaped string. One implementation of an interface
is a hypothesis; the second is the proof. Caddy is the candidate for the proxy (its
admin API would make routes resources with a real `read`, at the cost of an
`xcaddy` build for the Cloudflare DNS module), and the exercise is worth doing once
the fleet is migrated rather than as a variable inside the migration.
