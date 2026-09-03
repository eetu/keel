/**
 * Nobody's house: documentation ranges, a reserved zone, and values chosen so
 * that anything which leaked in from a real installation is visible in the diff.
 *
 * Shared because both goldens hash bodies rendered from it — the committed one
 * for the example catalog, the installation's own for its local catalog — and two
 * copies of a fixture would be two sets of bytes that could drift apart.
 */

import { type Installation } from "../src/config/types";

export const HOUSE: Installation = {
  vault: "fixture",
  network: { lanCidr: "198.51.100.0/24", domain: "example.test" },
  mesh: {
    v4: "198.18.0.0/15",
    v6: "2001:db8:e5:1::/64",
    stunPort: 3478,
    agentWireguardPort: 51820,
  },
  smtp: { host: "smtp.example.test", port: 587, security: "starttls" },
  publicHosts: [],
  backup: {
    host: "198.51.100.2",
    share: "backups",
    repoDir: "keel-restic",
    mountOptions: "vers=3.1.1,sec=ntlmsspi",
  },
  // Two, so that the rule "a share nothing mounts gets no unit" is asserted
  // against a house that has one of each rather than against a list of one.
  // `/var/mnt` because `/mnt` is an ostree symlink into it and the guard refuses
  // the symlinked spelling — a fixture on the wrong side of that rule would make
  // every other rule here untestable.
  shares: [
    {
      mountpoint: "/var/mnt/music",
      host: "198.51.100.2",
      share: "music",
      mountOptions: "vers=3.1.1,sec=ntlmsspi",
      readOnly: true,
    },
    {
      mountpoint: "/var/mnt/scratch",
      host: "198.51.100.2",
      share: "scratch",
      mountOptions: "vers=3.1.1,sec=ntlmsspi",
      readOnly: false,
    },
  ],
  // No boards: a golden is rendered from entries and a house, and a host is what
  // selects entries rather than anything that reaches a body.
  hosts: {},
};
