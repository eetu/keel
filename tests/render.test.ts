/**
 * What has to be true of the image whatever its files say.
 *
 * `image.test.ts` pins every rendered byte, so nothing here repeats a line the
 * renderer wrote. Each test states a rule whose violation would be silent on the
 * board — an address that made one image one house's, a set that shipped with an
 * element in it, a login policy that named an account — and says why the rule
 * exists, which a snapshot diff cannot.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ADMIN_GROUP, ADMIN_USER, NETWORKS, UNBOUND } from "../src/config/keel";
import { PROFILES, resolveMemory } from "../src/config/profiles";
import { SERVICES } from "../src/config/services";
import { MASKED_UNITS, REQUIRED_UNITS } from "../src/config/versions";
import { renderAll } from "../src/render";
import { NETWORK_INTERFACES } from "../src/render/quadlet";
import { file, merge } from "../src/render/tree";

const { tree } = renderAll();
const content = (path: string): string => tree.get(path)?.content ?? "";

describe("one image, every board", () => {
  it("refuses two renderers writing the same path", () => {
    // The later writer would win silently, which is the class of surprise the
    // render step exists to remove. Renaming the file is not the fix either.
    expect(() => merge(file("/etc/a", "x"), file("/etc/a", "y"))).toThrow(/two renderers/);
  });

  it("produces files at absolute paths", () => {
    expect(tree.size).toBeGreaterThan(0);
    for (const path of tree.keys()) expect(path.startsWith("/")).toBe(true);
  });

  it("ships no key material or decrypted secret", () => {
    for (const [path, entry] of tree) {
      expect(entry.content, path).not.toMatch(/-----BEGIN/);
      expect(entry.content, path).not.toMatch(/AGE-SECRET-KEY-1/);
      expect(path).not.toMatch(/^\/etc\/secrets\//);
    }
  });

  it("enables by preset every unit it ships with an [Install] section, and every required one", () => {
    // A unit with an [Install] section nobody enables is inert and looks
    // installed; a preset line naming a unit the image does not carry is a
    // preset that enables nothing. Package units are the remainder, and the
    // required ones among them are the boot's rollback triggers.
    const enabled = content("/usr/lib/systemd/system-preset/50-keel.preset")
      .trimEnd()
      .split("\n")
      .map((line) => line.replace(/^enable /, ""));
    for (const unit of REQUIRED_UNITS) expect(enabled, unit).toContain(unit);
    for (const unit of enabled.filter((name) => name.startsWith("keel-"))) {
      expect(tree.has(`/usr/lib/systemd/system/${unit}`), unit).toBe(true);
    }
    for (const [path, entry] of tree) {
      const unit = /^\/usr\/lib\/systemd\/system\/([^/]+\.(?:service|timer))$/.exec(path)?.[1];
      if (unit === undefined || !entry.content.includes("[Install]")) continue;
      expect(enabled, unit).toContain(unit);
    }
  });
});

describe("the image describes no network and no host", () => {
  // The headline invariant of a generic image: an address or a name in here is a
  // fact about one installation, and an installation is not something an artefact
  // that boots every board is allowed to know. Nothing is whitelisted — anything
  // that trips this has to stop being rendered.
  const forbidden: readonly (readonly [string, RegExp])[] = [
    ["RFC1918 10/8 address", /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
    ["RFC1918 172.16/12 address", /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/],
    ["RFC1918 192.168/16 address", /\b192\.168\.\d{1,3}\.\d{1,3}\b/],
    ["carrier-grade NAT 100.64/10 address", /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./],
    ["unique-local IPv6 address", /\bfd[0-9a-f]{2}:/i],
    // A board's name reaches a tree only through a renderer that read
    // `installation.ts`; the structural half of that rule is the import scan.
    ["host name from installation.example.ts", /\brasp[io]\b/i],
  ];

  // The one exception, and it is not an installation's: the two bridges' subnets
  // and gateways are the image's own facts (`NETWORKS`), the same on every board,
  // pinned so a service can name the address the proxy reaches it from. Exactly
  // those strings are blanked before matching; any other address still fails.
  const own = Object.values(NETWORKS).flatMap((network) => [network.subnet, network.gateway]);
  const withoutOwnBridges = (text: string): string =>
    own.reduce((rest, address) => rest.replaceAll(address, ""), text);

  it.each(forbidden)("holds no %s", (_label, pattern) => {
    for (const [path, entry] of tree) {
      expect(path, path).not.toMatch(pattern);
      expect(withoutOwnBridges(entry.content), path).not.toMatch(pattern);
    }
  });

  it("names no host", () => {
    // The hostname belongs to the board, and keel-firstboot takes it from the
    // card. An image that shipped one would make every board the same machine.
    expect(tree.get("/etc/hostname")).toBeUndefined();
  });

  it.each(SERVICES)("names $name nowhere", (spec) => {
    // A blank card boots to a bare machine and the configuration layer installs
    // what runs on it. So the image stages nothing for a service — no quadlet,
    // no unit, no memory drop-in, no state directory, no promise in the selftest
    // — which in its general form is that a service's name occurs nowhere in the
    // tree. Unbound is a package with no catalog entry and so outside the rule.
    for (const [path, entry] of tree) {
      expect(path, path).not.toContain(spec.name);
      expect(entry.content, path).not.toContain(spec.name);
    }
  });
});

describe("the image renders from committed configuration", () => {
  // `installation.ts` is gitignored and installation-specific. A renderer that
  // read it would put a particular network into an artefact that boots every
  // board — and CI, which has only the examples, would build a different image
  // from the one on the bench. The catalog is held to the same rule, because the
  // renderers read it: an entry is handed the installation, never reaching for it.
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const modules = (["render", "config", "adapters"] as const).flatMap((dir) =>
    // Recursive, so a module in a subdirectory cannot escape by being somewhere
    // this list did not look.
    readdirSync(`${root}/${dir}`, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".ts") && !/^installation\b/.test(name))
      .map((name) => `${dir}/${name}`),
  );

  it.each(modules)("%s imports no installation config", (name) => {
    const source = readFileSync(`${root}/${name}`, "utf8");
    expect(source).not.toMatch(/from "\.{1,2}\/(\.\.\/)?config\/installation"/);
  });
});

describe("who may reach a board", () => {
  // Three files decide it: the one sshd admits, the one sudo grants, and the one
  // keel-firstboot puts the account in. A board where they disagree boots with
  // nobody able to authenticate to it at all — ssh included, and a screen too,
  // since the image has no usable password either.
  const sshd = content("/etc/ssh/sshd_config");
  const sudoers = tree.get("/etc/sudoers.d/keel-admin");

  it("refuses passwords and root over ssh", () => {
    expect(sshd).toContain("PermitRootLogin no");
    expect(sshd).toContain("PasswordAuthentication no");
  });

  it("admits a group and names no account", () => {
    // Membership rather than a name, so one image serves every fleet and
    // changing the account locks nobody out. Asserted as the absence of the
    // three directives that can name an account.
    expect(sshd).toContain(`AllowGroups ${ADMIN_GROUP}`);
    expect(sshd).not.toMatch(/^\s*(Allow|Deny)Users\b/im);
    expect(sshd).not.toMatch(/^\s*Match\s+User\b/im);
  });

  it("grants that group passwordless sudo, and nobody else", () => {
    // Every device resource reaches a host as `ssh <alias> sudo …`, so without
    // this the whole Pulumi layer fails; and sudo ignores a group- or
    // world-writable drop-in entirely.
    expect(sudoers?.content).toBe(`%${ADMIN_GROUP} ALL=(ALL) NOPASSWD:ALL\n`);
    expect(sudoers?.mode).toBe(0o440);
  });

  it("creates the admin account in that group and converges the membership", () => {
    // An account outside the group exists and cannot log in, and first boot is
    // the only thing that puts it back: nothing on the machine has a password.
    const script = content("/usr/bin/keel-firstboot");
    expect(script).toContain(`admin=${ADMIN_USER}`);
    expect(script).toContain(`group=${ADMIN_GROUP}`);
    expect(script).toContain('useradd -m -G "$group" "$admin"');
    expect(script).toContain('usermod -aG "$group" "$admin"');
  });
});

describe("keel-firstboot", () => {
  const script = content("/usr/bin/keel-firstboot");

  it("parses the file and never executes it", () => {
    // It is removable media anyone holding the card can write to, so a shell
    // that sourced it would hand them root.
    expect(script).not.toContain("source");
    expect(script).not.toContain(". /boot");
    expect(script).not.toContain("eval ");
  });

  it("lets nft judge the ranges file before nftables.service has to", () => {
    // The shape globs cannot catch an out-of-range octet, and a file nft rejects
    // fails nftables.service — a required unit — turning a typo on the card into
    // a failed boot.
    expect(script).toContain('nft -c -f "$tmp"');
  });
});

describe("masked units", () => {
  it.each(MASKED_UNITS)("%s is masked, not merely disabled", (unit) => {
    // A disabled unit still starts when something pulls it in as a dependency;
    // a symlink to /dev/null is what actually prevents that.
    expect(tree.get(`/etc/systemd/system/${unit}`)?.symlinkTo).toBe("/dev/null");
  });
});

describe("packet filter", () => {
  const nft = content("/usr/lib/keel/nftables/keel.nft");

  it("denies by default in both directions", () => {
    expect(nft).toContain("type filter hook input priority filter; policy drop;");
    expect(nft).toContain("type filter hook forward priority filter; policy drop;");
  });

  it("declares every set the drop-ins fill, and ships them all empty", () => {
    // An empty set matches nothing, so an image with no keel.conf admits nothing
    // — fail closed by construction rather than by an accurate list.
    expect(nft).toContain("set lan4 { type ipv4_addr; flags interval; }");
    expect(nft).toContain("set mesh4 { type ipv4_addr; flags interval; }");
    expect(nft).toContain("set mesh6 { type ipv6_addr; flags interval; }");
    for (const name of ["lan_tcp", "lan_udp", "mesh_tcp", "mesh_udp", "world_tcp", "world_udp"]) {
      expect(nft, name).toContain(`set ${name} { type inet_service; }`);
    }
    expect(nft).not.toContain("elements");
  });

  it("opens SSH from the two source sets and leaves every other port to a set", () => {
    // SSH is the port a board has to answer to be fixable at all. Everything
    // else is a service someone deployed, so it arrives with the deployment.
    const serviceRules = nft
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("dport") && !line.includes("sport"));
    for (const rule of serviceRules) {
      const literal = /dport (\d+)/.exec(rule);
      if (literal) expect(literal[1], rule).toBe("22");
    }
    expect(serviceRules.filter((rule) => rule.includes("dport 22"))).toEqual([
      "ip saddr @lan4 tcp dport 22 accept",
      "ip saddr @mesh4 tcp dport 22 accept",
      "ip6 saddr @mesh6 tcp dport 22 accept",
    ]);
  });

  it("forwards for the open bridge alone", () => {
    // The forward chain is where a container earns internet access: only
    // keel-open's bridge may originate traffic off the host, keel-internal's
    // falls to the drop policy.
    const forward = nft.slice(nft.indexOf("chain forward"));
    expect(forward).toContain(`iifname "${NETWORK_INTERFACES.open}" accept`);
    expect(forward).not.toContain(NETWORK_INTERFACES.internal);
  });
});

describe("the resolver the image carries", () => {
  const conf = content("/etc/unbound/conf.d/keel.conf");

  it("listens on loopback only", () => {
    // Pi-hole is unbound's sole client; the LAN talks to Pi-hole.
    expect(conf).toContain("interface: 127.0.0.1");
    expect(conf).toContain(`port: ${UNBOUND.port}`);
    expect(conf).toContain("access-control: 127.0.0.0/8 allow");
  });

  it("keeps its caches inside its memory cap", () => {
    // Unbound treats these as ceilings and fills them, so cache larger than the
    // cgroup allows means being OOM-killed once they warm up.
    const cap = resolveMemory("unbound", PROFILES[0]).maxMb;
    const msg = Number(/msg-cache-size: (\d+)m/.exec(conf)?.[1]);
    const rrset = Number(/rrset-cache-size: (\d+)m/.exec(conf)?.[1]);
    expect(msg + rrset).toBeLessThan(cap);
  });

  it("labels its port from a unit that never conditions itself on the tool it runs", () => {
    // A ConditionPathExists on semanage turns a missing package into a skipped
    // unit: nothing fails, nothing is logged, and the first evidence is unbound
    // refusing to bind on the host that is the LAN's resolver. The one condition
    // of that shape it may carry: with SELinux off there is no label to apply.
    const unit = content("/usr/lib/systemd/system/keel-selinux.service");
    expect(unit).not.toContain("ConditionPathExists");
    expect(unit).toContain("ConditionSecurity=selinux");
    expect(unit).toContain("Before=unbound.service");
  });
});
