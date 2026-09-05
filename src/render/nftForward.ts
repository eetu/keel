/**
 * The forward chain's drop-ins: what this host routes for, as a packet-filter
 * file the deploy layer writes.
 *
 * Two rules, and both are the deploy's rather than the image's for the same
 * reason — what a board forwards is a property of what it runs, and the image
 * runs on every board. The open bridge's accept is also in `keel.nft`, so a
 * board on a current image holds it twice, which costs one comparison on packets
 * the first copy already accepted; a board on an older image gets it only from
 * here, and without it every container on `keel-open` is severed from the
 * internet with nothing anywhere saying so. The mesh interface's accept is in no
 * image at all: routing the LAN to connected peers is what one board does and
 * what the others must not.
 *
 * Same additive mechanism as the port drop-ins (`nftPorts.ts`): re-open the
 * table, re-declare the chain, and nft merges.
 */

import { NETWORK_INTERFACES } from "./quadlet";

/**
 * `20-`, so it loads after `keel-firstboot`'s address ranges and before the
 * per-service port files. Nothing here depends on that order; it keeps the
 * directory readable in the order the rules were decided.
 */
export const NFT_FORWARD_PATH = "/etc/keel/nft.d/20-forward-open.nft";

/** Copied from `keel.nft`, so a re-declaration on a board that has the chain matches it. */
const FORWARD_CHAIN_SPEC = "        type filter hook forward priority filter; policy drop;";

/**
 * The chain's own spec is restated rather than assumed. On a board whose image
 * predates the forward chain entirely, a bare `chain forward { … }` would create
 * a *regular* chain — one no hook ever calls — and the rule would be installed,
 * visible in `nft list table`, and dead. Declaring the hook and policy makes the
 * file correct on such a board and a no-op on every other one: nft accepts a
 * re-declaration whose spec matches, and this one is copied from the image.
 *
 * `open` is whether anything the host deploys is actually on that bridge, and
 * `meshInterface` is the overlay device when this board enrols as the mesh's
 * routing peer. With neither, the file is still written and holds only a comment
 * — the same rule as the port drop-in: a body that became an absent file would
 * be a deletion, and a deletion runs *after* the reload, so the reload run to
 * withdraw an accept would re-read the copy still on disk and re-install it.
 *
 * The mesh rule is `iifname` alone. `ct state established,related` above it
 * carries every reply back, so what this admits is exactly what a connected peer
 * originates — and nothing on the LAN can open a connection into the overlay,
 * which is the same direction the old repository's one `route allow in` had.
 */
export function renderNftForward(open: boolean, meshInterface?: string): string {
  const rules = [
    ...(open
      ? [
          "        # Egress for the open bridge. The image's keel.nft carries the same",
          "        # accept; a chain holding it twice behaves like one holding it once.",
          `        iifname "${NETWORK_INTERFACES.open}" accept`,
        ]
      : []),
    ...(meshInterface === undefined
      ? []
      : [
          "        # This board is the mesh's routing peer: a connected device reaches",
          "        # the LAN through here. In no image — which board routes is a",
          "        # property of what it runs, and the image runs on all of them.",
          `        iifname "${meshInterface}" accept`,
        ]),
  ];
  if (rules.length === 0) {
    return [
      "# This host neither joins the open bridge nor routes for the mesh, so the",
      "# forward chain accepts nothing beyond the replies keel.nft already admits.",
      "# Written rather than removed: a deletion would run after the reload that",
      "# is withdrawing a rule, and the reload would re-read the old file.",
      "",
    ].join("\n");
  }
  return [
    "table inet keel {",
    "    chain forward {",
    FORWARD_CHAIN_SPEC,
    ...rules,
    "    }",
    "}",
    "",
  ].join("\n");
}
