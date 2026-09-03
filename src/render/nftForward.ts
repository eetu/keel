/**
 * The forward-chain rule that lets the open bridge's containers reach the
 * internet, as a packet-filter drop-in the deploy layer writes.
 *
 * The image's own `keel.nft` carries this same rule, so a board booted from a
 * current image needs nothing from here. A board running an older one has the
 * forward chain and its drop policy but not the accept, and every container on
 * `keel-open` is severed from the internet until it arrives — a service declared
 * `egress: "open"` silently cannot reach what it was opened up for. That is a
 * fix worth a `pulumi up` rather than an image rebuild and a reboot of the host
 * that serves LAN DNS.
 *
 * Same additive mechanism as the port drop-ins (`nftPorts.ts`): re-open the
 * table, re-declare the chain, and nft merges. When both the image and this file
 * carry the rule the chain simply holds it twice, which costs one comparison on
 * the packets the first copy already accepted.
 */

import { NETWORK_INTERFACES } from "./quadlet";

/**
 * `20-`, so it loads after `keel-firstboot`'s address ranges and before the
 * per-service port files. Nothing here depends on that order; it keeps the
 * directory readable in the order the rules were decided.
 */
export const NFT_FORWARD_PATH = "/etc/keel/nft.d/20-forward-open.nft";

/**
 * The chain's own spec is restated rather than assumed. On a board whose image
 * predates the forward chain entirely, a bare `chain forward { … }` would create
 * a *regular* chain — one no hook ever calls — and the rule would be installed,
 * visible in `nft list table`, and dead. Declaring the hook and policy makes the
 * file correct on such a board and a no-op on every other one: nft accepts a
 * re-declaration whose spec matches, and this one is copied from the image.
 *
 * `open` is whether anything the host deploys is actually on that bridge. When
 * nothing is, the file is still written and holds only a comment — the same rule
 * as the port drop-in: a body that became an absent file would be a deletion, and
 * a deletion runs *after* the reload, so the reload run to withdraw this accept
 * would re-read the copy still on disk and re-install it.
 */
export function renderNftForward(open: boolean): string {
  if (!open) {
    return [
      "# Nothing on this host joins the open bridge, so no forward accept.",
      "# Written rather than removed: a deletion would run after the reload that",
      "# is withdrawing this rule, and the reload would re-read the old file.",
      "",
    ].join("\n");
  }
  return [
    "# Egress for the open bridge. The image's keel.nft carries the same accept;",
    "# a board running an image that predates it gets the rule from here, and a",
    "# chain holding it twice behaves exactly like one holding it once.",
    "table inet keel {",
    "    chain forward {",
    "        type filter hook forward priority filter; policy drop;",
    `        iifname "${NETWORK_INTERFACES.open}" accept`,
    "    }",
    "}",
    "",
  ].join("\n");
}
