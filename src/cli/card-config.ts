/**
 * Emit `keel.conf` for a host — the identity `keel-firstboot` reads off the
 * ESP on every boot, since one generic image serves every board.
 *
 *   yarn card-config raspi > build/card/keel.conf
 *
 * The admin key has to be on the card because first boot has to be reachable
 * and there is no other way in: sshd refuses passwords and root, and admits
 * only the admin group — whose one member on a fresh board is the account
 * keel-firstboot creates and installs these keys for.
 */

import process from "node:process";

import { INSTALLATION } from "../config/installation";

const { network, mesh, hosts } = INSTALLATION;

const hostName = process.argv[2];
const host = hostName === undefined ? undefined : hosts[hostName];

if (hostName === undefined || host === undefined) {
  console.error(`usage: yarn card-config <host>   (known: ${Object.keys(hosts).join(", ")})`);
  process.exit(2);
}

const keys = host.adminKeys ?? [];
if (keys.length === 0) {
  console.error(`${hostName} has no adminKeys — the card would boot with no way in`);
  process.exit(1);
}

const lines = [
  `KEEL_HOSTNAME=${hostName}`,
  ...keys.map((key) => `KEEL_ADMIN_KEY=${key}`),
  `KEEL_LAN_CIDR=${network.lanCidr}`,
  `KEEL_MESH_V4=${mesh.v4}`,
  `KEEL_MESH_V6=${mesh.v6}`,
];

process.stdout.write(`${lines.join("\n")}\n`);
