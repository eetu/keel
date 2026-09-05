import { REQUIRED_UNITS } from "../config/versions";
import { KEEL_ALERT_TIMER, renderAlert } from "./alert";
import { renderBase, renderPresets } from "./base";
import { renderContainers } from "./containers";
import { renderDns } from "./dns";
import { renderFirstboot } from "./firstboot";
import { renderFlightRecorder } from "./flightrecorder";
import { KEEL_HOSTS_SERVICE, KEEL_HOSTS_TIMER, renderHosts } from "./hosts";
import { renderMemory } from "./memory";
import { KEEL_MESH_SERVICE, renderMesh } from "./mesh";
import { renderNetwork } from "./network";
import { renderNftables } from "./nftables";
import { renderNetworks } from "./quadlet";
import { KEEL_REMOUNT_TIMER, renderRemount } from "./remount";
import { renderSecrets } from "./secrets";
import { renderSelftest, type Validation } from "./selftest";
import { renderSelinux, SELINUX_UNIT } from "./selinux";
import { merge, type Tree } from "./tree";
import { renderUpdates } from "./updates";

/**
 * Units enabled by preset. One image boots every board, so this is the whole
 * list: there is nothing a host can decline and nothing waiting on a declaration
 * somewhere else.
 *
 * `keel-firstboot.service` is enabled but is not a required unit. On a card
 * carrying no `keel.conf` it logs one line and exits 0, which is what a freshly
 * built image looks like — and greenboot must not roll an image back for not
 * having been given an identity yet. The selftest observes it as an advisory
 * instead.
 */
const UNITS = [
  "sshd.service",
  "nftables.service",
  "systemd-oomd.service",
  "keel-secrets.service",
  "keel-growfs.service",
  "keel-firstboot.service",
  // chrony's own wait: holds `time-sync.target` until the clock is synchronised,
  // giving up after 180 s so a board with no NTP still finishes booting. The
  // persistent timers order after that target — and only they do: gating
  // `timers.target` itself hangs the boot, because unbound waits on
  // `unbound-anchor.timer`.
  "chrony-wait.service",
  "unbound.service",
  SELINUX_UNIT,
  // Resolves a share's or the backup target's NetBIOS name into /etc/hosts.
  KEEL_HOSTS_SERVICE,
  // Re-runs the resolution every five minutes, so a moved node reaches
  // /etc/hosts without a reboot.
  KEEL_HOSTS_TIMER,
  // Posts failed and crash-looping units to the alert sink, every five minutes.
  // The timer alone: the service it fires has no [Install] of its own.
  KEEL_ALERT_TIMER,
  // Retries every failed network mount and starts what requires it, every five
  // minutes — systemd's `Restart=` has no counterpart for a mount.
  KEEL_REMOUNT_TIMER,
  // The mesh agent's daemon. Enabled on every board because there is one image;
  // one that was never enrolled idles, holding no interface and forwarding
  // nothing. Not a required unit: a board that is not a peer is a board doing
  // its job, and greenboot must not roll an image back for it.
  KEEL_MESH_SERVICE,
  "keel-podman-prune.timer",
  // Listed explicitly even though its own package presets it, so the
  // "every presetted unit is enabled" image check covers the thing that decides
  // whether a bad image gets rolled back.
  "greenboot-healthcheck.service",
  // Ships enabled by bootc itself (a static wants-symlink, not a preset), listed
  // here for the same reason as greenboot-healthcheck above: this is the unit
  // that closes the update loop, so the image check that walks the preset file
  // is what catches it going missing.
  "bootc-fetch-apply-updates.timer",
  // The timer, not the service it triggers: the recorder fires on a clock so
  // that a boot which never reaches multi-user.target is still recorded, and the
  // service carries no [Install] of its own to enable. Not a required unit
  // either — a missing log is a debugging inconvenience, not a reason to roll an
  // image back.
  "keel-flightrecorder.timer",
];

/**
 * Configuration checks that need no running system, so an image can be judged
 * before it has ever booted.
 */
const VALIDATIONS: readonly Validation[] = [
  // unbound refuses to start on a config it dislikes, and that costs the LAN its
  // recursion — so the config is checked in the image, before a boot.
  // `unbound-checkconf` insists its pidfile directory exists, and /run/unbound is
  // created by the package's tmpfiles at boot, so an unbooted image has to be
  // given it first.
  { label: "unbound config", command: "mkdir -p /run/unbound && unbound-checkconf" },
];

/**
 * Observations logged at every boot that must never roll an image back.
 *
 * Forwarding is the routing peer's whole precondition and it fails in silence:
 * the mesh connects, the dashboard is green, the routes are there, and every
 * packet aimed at the LAN is dropped by a kernel that was never told to forward.
 * Advisory rather than required because a board that forwards nothing is a board
 * doing its job everywhere else — the failure belongs in the boot log and in the
 * flight recorder, not in a rollback.
 */
const ADVISORIES: readonly Validation[] = [
  // Written without a double quote in it, because the selftest embeds a check's
  // command inside one twice — once to run it and once to name it in the
  // failure. A quote here would close that string and run the rest as shell.
  {
    label: "IP forwarding",
    command: "! sysctl -n net.ipv4.ip_forward net.ipv6.conf.all.forwarding | grep -qvx 1",
    // The sysctl a container reads is the host's, so the check would report the
    // laptop that built the image rather than the board that boots it.
    hostOnly: true,
  },
];

export type RenderResult = {
  tree: Tree;
};

/**
 * The image, whole. It takes no host: every board boots the same artefact, and
 * what makes one of them a particular machine arrives afterwards — `keel.conf`
 * on the ESP for its identity, Pulumi for the services it runs.
 */
export function renderAll(): RenderResult {
  return {
    tree: merge(
      renderBase(),
      renderSecrets(),
      renderNetworks(),
      renderNetwork(),
      renderFirstboot(),
      renderFlightRecorder(),
      renderContainers(),
      renderDns(),
      renderHosts(),
      renderMesh(),
      renderAlert(),
      renderRemount(),
      renderSelinux(),
      renderNftables(),
      renderSelftest(REQUIRED_UNITS, VALIDATIONS, ADVISORIES),
      renderMemory(),
      renderPresets(UNITS),
      renderUpdates(),
    ),
  };
}
