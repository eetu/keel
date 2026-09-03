/**
 * Byte-for-byte snapshots of every body a `pulumi up` writes to a running host,
 * for the example catalog — the five services keel ships as itself.
 *
 * A service's restart trigger is a hash of its quadlet, its memory drop-in and
 * the files its entry marks as restarting, so one byte anywhere in here is a
 * container restart: an environment variable that moved in insertion order, a
 * rendered comment reflowed, a middleware list reordered. On the host that
 * serves the LAN's DNS, its TLS and its identity, that is an outage — so these
 * bodies are pinned, and a change to any of them has to be intended and stated
 * rather than discovered on the board.
 *
 * The installation is a fixture and never the real one. A committed snapshot may
 * not name anybody's house, and CI renders from committed configuration alone —
 * so a golden generated from `installation.ts` would be a leak on one machine and a
 * failure on the other.
 *
 * The local catalog's entries are pinned the same way by `golden.local.test.ts`,
 * which is gitignored along with its snapshot: what one installation runs is not
 * something to publish, and a clone whose local catalog differs would fail every
 * snapshot in it.
 */

import { describe, expect, it } from "vitest";

import { EXAMPLE_SERVICES } from "../src/config/services";
import { catalogOf } from "../src/config/spec";
import { certSyncBodies } from "../src/infra/certSync";
import { pinBodies } from "./goldenBodies";
import { HOUSE } from "./house";

/**
 * The example catalog resolved on its own, which is what a clone deploys: the
 * proxy, the identity provider and the gate are all in it, so a local catalog
 * adds vhosts behind them and changes nothing about these five.
 */
const CATALOG = catalogOf(EXAMPLE_SERVICES);

pinBodies(EXAMPLE_SERVICES, CATALOG, HOUSE);

describe("the certificate sync", () => {
  // Derived from the two declarations it connects — the store the proxy fills and
  // the directory one entry reads its certificate from — so these bodies are what
  // a deploy writes for whoever declares one.
  const consumer = EXAMPLE_SERVICES.find((spec) => spec.certificates !== undefined)!;
  const sync = certSyncBodies(CATALOG.proxy!.role, consumer);

  it("extracts the certificate with the same script", () => {
    expect(sync.script.content).toMatchSnapshot();
  });

  it("runs it from the same unit", () => {
    expect(sync.service).toMatchSnapshot();
  });

  it("watches the store with the same path unit", () => {
    expect(sync.pathUnit).toMatchSnapshot();
  });
});
