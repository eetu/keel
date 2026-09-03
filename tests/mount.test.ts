import { describe, expect, it } from "vitest";

import { INSTALLATION } from "../src/config/installation";
import { SERVICES } from "../src/config/services";
import { SHARE_CREDENTIAL_FIELDS, SHARE_VAULT_ITEM } from "../src/config/shares";
import { type ServiceSpec } from "../src/config/spec";
import { type Share } from "../src/config/types";
import { KEEL_HOSTS_SERVICE } from "../src/render/hosts";
import {
  canonicalPath,
  credentialsPath,
  isIpAddress,
  MOUNT_HELPER,
  mountedShares,
  mountUnit,
  mountUnitName,
} from "../src/render/mount";
import { HOUSE } from "./house";

const MUSIC = HOUSE.shares[0];
const SCRATCH = HOUSE.shares[1];

/** A fixture entry, so a rule is asserted on a declaration and not on a house. */
const consumer = (name: string, mounts?: readonly string[]): ServiceSpec => ({
  name,
  description: "fixture",
  image: `example.test/${name}@sha256:${"0".repeat(64)}`,
  port: 9000,
  memory: { max: 32, tier: "apps" },
  subdomain: null,
  auth: "open",
  mounts,
});

describe("the unit name is systemd's own", () => {
  // Ground truth from `systemd-escape --suffix=mount --path` on the fleet's own
  // board. A name that differs by one byte is a unit nothing ever starts.
  it.each([
    ["/var/mnt/music", "var-mnt-music.mount"],
    // `-` is what a `/` becomes, so an actual dash is escaped.
    ["/var/mnt/my-share", "var-mnt-my\\x2dshare.mount"],
    ["/var/mnt/my music", "var-mnt-my\\x20music.mount"],
    // `:`, `_` and an interior `.` pass through; a leading dot would hide the file.
    ["/srv/a_b.c:d", "srv-a_b.c:d.mount"],
    ["/.dotdir", "\\x2edotdir.mount"],
    // Byte by byte, and simplified before escaping.
    ["/mnt/ä", "mnt-\\xc3\\xa4.mount"],
    ["/var/mnt//music/", "var-mnt-music.mount"],
    ["/", "-.mount"],
  ])("escapes %s to %s", (path, unit) => {
    expect(mountUnitName(path)).toBe(unit);
  });

  it("refuses a relative mountpoint", () => {
    expect(() => mountUnitName("mnt/music")).toThrow(/absolute/);
  });
});

describe("a mountpoint is canonical on this image or it is refused", () => {
  // `/mnt -> var/mnt`, `/srv -> var/srv`, `/home -> var/home`, `/root ->
  // var/roothome`, `/media -> run/media`, and the `/usr` merges. systemd loads a
  // mount unit only if `Where=` resolves through none of them.
  it.each([
    ["/mnt/music", "/var/mnt/music"],
    ["/srv/data", "/var/srv/data"],
    ["/home/someone/library", "/var/home/someone/library"],
    ["/root/x", "/var/roothome/x"],
    ["/media/usb", "/run/media/usb"],
    ["/lib64/x", "/usr/lib64/x"],
    ["/var/mnt/music", "/var/mnt/music"],
    ["/mntx/y", "/mntx/y"],
  ])("resolves %s to %s", (path, canonical) => {
    expect(canonicalPath(path)).toBe(canonical);
  });

  it("names the canonical spelling when a share uses the symlinked one", () => {
    const wrong: Share = { ...MUSIC, mountpoint: "/mnt/music" };
    expect(() => mountedShares([], [wrong])).toThrow(
      /music share mounts on \/mnt\/music.*state \/var\/mnt\/music/,
    );
  });

  it("refuses the half-fix: a canonical share and an entry still binding the symlink", () => {
    // podman resolves the symlink when it binds, so the library is there — but
    // quadlet writes `RequiresMountsFor=/mnt/music` from that `Volume=` line and
    // systemd does not chase symlinks resolving it, so the service holds no
    // dependency on the mount and starts against whatever is under the path.
    const navidrome = consumer("navidrome", ["/mnt/music:/music:ro"]);
    expect(() => mountedShares([navidrome], HOUSE.shares)).toThrow(
      /navidrome binds \/mnt\/music.*bind \/var\/mnt\/music/,
    );
  });
});

describe("a share's own fields are held to what a unit can be built from", () => {
  const refuses = (share: Share, ...expected: (string | RegExp)[]): void => {
    // Both entry points, because either one alone would leave a unit body that
    // could be composed from an unchecked share.
    for (const pattern of expected) {
      expect(() => mountedShares([], [share]), "mountedShares").toThrow(pattern);
      expect(() => mountUnit(share), "mountUnit").toThrow(pattern);
    }
  };

  it.each([
    ["/var/mnt/media-nas", "var-mnt-media\\x2dnas.mount", "/var/mnt/media_nas"],
    ["/var/mnt/musiikkiä", "var-mnt-musiikki\\xc3\\xa4.mount", "/var/mnt/musiikki_"],
  ])("refuses %s, whose unit name %s cannot be transported", (mountpoint, unit, suggestion) => {
    // ssh joins its arguments and the remote shell drops the backslash, so
    // `systemctl` would be handed a unit nothing wrote. Refused naming the rename.
    refuses({ ...MUSIC, mountpoint }, mountpoint, `escapes to ${unit}`, suggestion);
  });

  it.each([
    { host: "nas 198.51.100.9" },
    { host: "nas\nExecStart=/bin/sh" },
    { share: "mu sic" },
    { mountOptions: "vers=3.1.1 sec=ntlmsspi" },
    { mountOptions: "vers=3.1.1\nWhat=//nas/other" },
  ])("refuses whitespace in %o", (field) => {
    // A unit file is line-oriented and systemd runs this one as root: a space is
    // a second word on `What=` and a newline is a directive of the author's
    // choosing, in the section of their choosing.
    refuses({ ...MUSIC, ...field }, /carries whitespace/);
  });

  it.each([
    "password=hunter2",
    "pass=hunter2",
    "user=nas",
    "username=nas",
    "cred=/tmp/c",
    "guest",
    "ro",
    "rw",
  ])("refuses the mount option %s, which a share may not state", (option) => {
    // The unit is mode 644 and `systemctl cat` prints it, so a login reaches the
    // mount as a `credentials=` path or not at all; and `ro`/`rw` is `readOnly`'s
    // to say, these options landing after it with the kernel honouring the last.
    refuses({ ...MUSIC, mountOptions: `vers=3.1.1,${option}` }, /may not state/);
  });

  it("accepts what a share actually needs to say", () => {
    for (const share of [...HOUSE.shares, ...INSTALLATION.shares]) {
      expect(() => mountUnit(share), share.share).not.toThrow();
    }
    expect(() => mountUnit({ ...MUSIC, mountOptions: "" })).not.toThrow();
    expect(() => mountUnit({ ...MUSIC, host: "nas.example.test", share: "music$" })).not.toThrow();
  });
});

describe("the credentials", () => {
  it("are the body an env file already is, from the two logins the vault holds", () => {
    // A CIFS credentials file is `username=…` / `password=…`, which is exactly
    // what `readEnvFile` produces from a variable -> field map — so a share's
    // login travels the sealed path a service's environment does. The field
    // names are not guessable: one invented to look plausible fails at deploy
    // time with an empty value, which mounts as some truncated user or not at all.
    expect(SHARE_VAULT_ITEM).toBe("cifs");
    expect(SHARE_CREDENTIAL_FIELDS).toEqual({
      readOnly: { username: "readonly_username", password: "readonly_password" },
      readWrite: { username: "readwrite_username", password: "readwrite_password" },
    });
  });

  it("land where the boot-time decryption looks, named after the unit", () => {
    // `keel-secrets.service` opens `/etc/secrets/*.age` into the same name minus
    // the suffix; and two servers' `music` shares are two files.
    expect(credentialsPath(MUSIC)).toBe("/etc/secrets/var-mnt-music.creds");
    expect(credentialsPath({ ...MUSIC, mountpoint: "/var/mnt/other" })).not.toBe(
      credentialsPath(MUSIC),
    );
  });
});

describe("the mount unit", () => {
  const unit = mountUnit(MUSIC);
  const options = (share: Share) => /^Options=(.*)$/m.exec(mountUnit(share))![1].split(",");

  it("names the credentials file rather than carrying the login", () => {
    expect(unit).toContain(`credentials=${credentialsPath(MUSIC)}`);
    expect(unit).not.toMatch(/\b(pass|password|user|username)=/);
  });

  it("carries the share's own fields, read-only or writable as the share says", () => {
    expect(unit).toContain(`What=//${MUSIC.host}/${MUSIC.share}`);
    expect(unit).toContain(`Where=${MUSIC.mountpoint}`);
    expect(options(MUSIC)).toContain(MUSIC.mountOptions.split(",")[0]);
    expect(options(MUSIC)).toContain("ro");
    expect(options(SCRATCH)).toContain("rw");
    expect(options(SCRATCH)).not.toContain("ro");
  });

  it("cannot hold a login hostage to a NAS that is off", () => {
    // Without `nofail` systemd gives a network mount an implicit
    // `Before=remote-fs.target`, and `systemd-user-sessions.service` is after
    // that target — so an unreachable NAS would block ssh for the mount's whole
    // timeout, on a board whose only repair path is ssh.
    expect(unit).toContain("nofail");
  });

  it("waits for the secrets, closes the bare mountpoint, and mounts what the deploy probes for", () => {
    expect(unit).toContain("After=network-online.target keel-secrets.service");
    expect(unit).toContain("DirectoryMode=0700");
    // `Type=` and the probed helper have to name one filesystem: a helper nothing
    // checked for is the mount that comes up unauthenticated.
    expect(MOUNT_HELPER).toBe("/sbin/mount.cifs");
    expect(unit).toContain(`Type=${MOUNT_HELPER.slice("/sbin/mount.".length)}`);
  });

  it("waits for a name to reach /etc/hosts before mount.cifs looks it up", () => {
    // getaddrinfo reads /etc/hosts before anything else, so a share named
    // rather than addressed has to have its answer written before this unit's
    // first mount attempt — an address costs nothing on the same ordering.
    expect(unit).toContain(
      `After=network-online.target keel-secrets.service ${KEEL_HOSTS_SERVICE}`,
    );
    expect(unit).toContain(`Wants=network-online.target ${KEEL_HOSTS_SERVICE}`);
  });
});

describe("whether a host is already an address", () => {
  it.each([
    ["192.168.1.216", true],
    ["0.0.0.0", true],
    ["255.255.255.255", true],
    ["100.64.0.1", true],
    ["fd2b:9e41:7c05::1", true],
    ["::1", true],
    ["zenwifi", false],
    ["nas.example.test", false],
    ["256.1.1.1", false],
    ["192.168.1", false],
  ])("%s is an address: %s", (host, address) => {
    expect(isIpAddress(host)).toBe(address);
  });
});

describe("a share is mounted because something mounts it", () => {
  const navidrome = consumer("navidrome", [
    "/var/lib/navidrome:/data:Z",
    "/var/mnt/music:/music:ro",
  ]);

  it("gives the share a unit, named for its consumers, and none to a share nothing mounts", () => {
    const mounted = mountedShares([navidrome], HOUSE.shares);
    expect(mounted).toEqual([
      {
        share: MUSIC,
        unit: "var-mnt-music.mount",
        credentials: "/etc/secrets/var-mnt-music.creds",
        consumers: ["navidrome"],
      },
    ]);
  });

  it("mounts nothing for a deployed set that binds nothing but its own directories", () => {
    expect(
      mountedShares(
        [consumer("ntfy"), consumer("local", ["/var/lib/local:/data:Z"])],
        HOUSE.shares,
      ),
    ).toEqual([]);
  });

  it("counts a path inside the share as mounting it, whatever order the catalog is in", () => {
    const tracker = consumer("tracker", ["/var/mnt/scratch/mods:/mods:rw"]);
    const player = consumer("player", ["/var/mnt/scratch:/scene:ro"]);
    const mounted = mountedShares([player, tracker, navidrome], HOUSE.shares);
    expect(mounted.map((mount) => [mount.unit, mount.consumers])).toEqual([
      ["var-mnt-music.mount", ["navidrome"]],
      ["var-mnt-scratch.mount", ["player", "tracker"]],
    ]);
    expect(mountedShares([navidrome, tracker, player], HOUSE.shares)).toEqual(mounted);
  });

  it("refuses a mountpoint two shares claim", () => {
    expect(() =>
      mountedShares([navidrome], [MUSIC, { ...SCRATCH, mountpoint: "/var/mnt/music" }]),
    ).toThrow(/two shares mount on \/var\/mnt\/music/);
  });

  it("holds this installation's own catalog to it", () => {
    expect(() => mountedShares(SERVICES, INSTALLATION.shares)).not.toThrow();
  });
});
