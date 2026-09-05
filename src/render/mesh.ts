/**
 * The mesh agent: the daemon that makes a board a peer of the overlay rather
 * than only the machine that coordinates it.
 *
 * It is image content and not a quadlet, for the same reason unbound is a
 * package. The client holds a WireGuard interface, opens `/dev/net/tun`, and
 * installs a packet-filter table of its own — a container would need the
 * capabilities, the device and the host's network namespace, which is every
 * isolation a container buys given away, and a quadlet has no way to say the
 * rest. What it needs beyond the binary is host policy: forwarding on, which is
 * stated here rather than left to whatever the daemon does to the machine
 * behind everyone's back.
 *
 * Nothing here says which mesh. The management URL, the name the peer registers
 * under and the key it enrols with all arrive with the deploy, so the unit is
 * the same on every board and a board nobody enrolled runs a daemon that idles.
 */

import { dedent, file, merge, type Tree } from "./tree";

/** Where the image installs the client. `image/Containerfile` puts it there. */
export const MESH_AGENT_BINARY = "/usr/bin/netbird";

/**
 * The daemon's own profile directory, and the one thing about this that is not
 * the client's default.
 *
 * The client's default is `/var/lib/netbird`, which on this fleet is the
 * *coordinator's* data directory — keel derives a service's state directory
 * from its entry's name, and the coordinator's entry is called after the same
 * product. Sharing it would put the peer's private key inside the tree the
 * coordinator's snapshot covers and inside a bind mount podman relabels for a
 * container, so the two are separated by the one lever the client offers.
 */
const MESH_STATE_NAME = "netbird-agent";
export const MESH_STATE_DIR = `/var/lib/${MESH_STATE_NAME}`;

/**
 * The interface the client creates, which is its own default and is not stated
 * to it. The packet filter's forward rule matches on this name, so it is a fact
 * the deploy layer needs and therefore one written down.
 */
export const MESH_INTERFACE = "wt0";

/** The daemon's unit. */
export const KEEL_MESH_SERVICE = "keel-mesh.service";

/**
 * Named for what it does here rather than for the product, because
 * `netbird.service` is taken: the coordinator is a catalog entry of that name,
 * the deploy writes its quadlet, and a generator materialises
 * `netbird.service` into `/run/systemd/generator` — which outranks
 * `/usr/lib/systemd/system`. A unit here under that name would be shadowed by
 * the container's on the one board that runs both, and the agent would silently
 * never start. It is also the name `netbird service install` would claim if
 * somebody ran it by hand while debugging.
 */
function agentUnit(): Tree {
  return file(
    `/usr/lib/systemd/system/${KEEL_MESH_SERVICE}`,
    dedent(`
      [Unit]
      Description=NetBird agent — this board's own membership of the mesh
      Documentation=https://docs.netbird.io/how-to/getting-started
      # The daemon brings up a WireGuard interface and installs a packet-filter
      # table beside keel's, so it wants an addressed machine and a loaded filter
      # before it starts rather than racing both.
      Wants=network-online.target
      After=network-online.target nftables.service

      [Service]
      Type=simple
      # The profile directory, moved off the client's default — see MESH_STATE_DIR.
      # The daemon and the CLI are one binary and read it at start, so every
      # invocation the deploy makes exports the same value.
      Environment=NB_STATE_DIR=${MESH_STATE_DIR}
      # \`--log-file console\` puts the daemon's log in the journal, which is
      # volatile here. Its own default is /var/log/netbird/client.log, a file on
      # the boot medium written continuously for the life of the board.
      ExecStart=${MESH_AGENT_BINARY} service run --log-level info --log-file console
      Restart=always
      RestartSec=10
      # The peer's private key lives here, and systemd creating the directory is
      # what decides its mode — the daemon would make it itself, later, at
      # whatever the client's own umask gives.
      StateDirectory=${MESH_STATE_NAME}
      StateDirectoryMode=0700

      [Install]
      WantedBy=multi-user.target
    `),
  );
}

/**
 * Forwarding, as host policy rather than as a daemon's side effect.
 *
 * A routing peer forwards packets between the overlay and the LAN, which the
 * kernel refuses to do at all with these off. The client would turn them on
 * itself; stating them means the machine's forwarding posture is reviewable in
 * the same diff as everything else, and true from the boot rather than from
 * whenever a daemon got around to it.
 *
 * On every board, because there is one image — and safely so: the filter's
 * forward chain is policy drop, so a board with nothing to forward for forwards
 * nothing. What decides whether a packet crosses is `20-forward-open.nft`, which
 * the deploy writes from what the host actually runs.
 *
 * **The `accept_ra` pair is not decoration.** The kernel's default for
 * `accept_ra` is 1, which means "accept router advertisements only while this
 * interface does not forward" — so turning IPv6 forwarding on is, by itself, a
 * board that stops configuring its own IPv6 address from the LAN's router. 2 is
 * the value that means "accept them anyway", and it is what a forwarding host
 * that is also an ordinary IPv6 client has to say.
 */
function forwarding(): Tree {
  return file(
    "/usr/lib/sysctl.d/99-keel-forwarding.conf",
    dedent(`
      net.ipv4.ip_forward = 1
      net.ipv6.conf.all.forwarding = 1
      net.ipv6.conf.all.accept_ra = 2
      net.ipv6.conf.default.accept_ra = 2
    `),
  );
}

export function renderMesh(): Tree {
  return merge(agentUnit(), forwarding());
}
