/**
 * The golden's assertions, registered against whichever catalog is handed to
 * them.
 *
 * There are two goldens — the committed one over the example catalog, the
 * installation's own over its local catalog — and they have to pin the same
 * things about an entry, because an entry is an entry: same type, same renderers,
 * same restart trigger. So the bodies live here and each golden supplies its
 * list. Snapshots are resolved per test file, so the two never share a `.snap`.
 */

import { describe, expect, it } from "vitest";

import { PROFILES } from "../src/config/profiles";
import {
  type Catalog,
  runSetup,
  secretFileShape,
  type ServiceSpec,
  subdomainOf,
} from "../src/config/spec";
import { type Installation, type ServiceFile } from "../src/config/types";
import { serviceDropIn } from "../src/render/memory";
import { quadletPath, renderQuadlet } from "../src/render/quadlet";

/** The defaults `Service` applies to a file an entry did not spell them out on. */
function fileLine(file: ServiceFile): string {
  return `${file.name} ${file.path} mode=${file.mode ?? "644"} restarts=${file.restarts !== false}`;
}

/**
 * Every body a `pulumi up` writes for each of `entries`, snapshotted.
 *
 * The catalog is passed in rather than derived from the list: a deploy resolves
 * the roles over everything it deploys, so a local entry's route is rendered by
 * the proxy the example catalog contributes.
 */
export function pinBodies(
  entries: readonly ServiceSpec[],
  catalog: Catalog,
  house: Installation,
): void {
  const proxy = catalog.proxy!.role;

  describe.each(entries)("$name", (spec: ServiceSpec) => {
    const setup = runSetup(spec, house, catalog);
    const files = setup?.files ?? [];
    const secretFiles = setup?.secretFiles ?? [];

    it("writes the same set of files", () => {
      // A path is as load-bearing as a body: a moved file is a resource replaced,
      // and one whose `restarts` flag flipped is a restart that stops happening.
      // A generated file lands as the blob beside the name it decrypts to, which
      // is the path a quadlet's `Volume=` line has to name.
      const written = [
        `quadlet ${quadletPath(spec)}`,
        ...(subdomainOf(spec) === null ? [] : [`route ${proxy.routePath(spec)}`]),
        ...files.map(fileLine),
        ...secretFiles.map((file) => `secret ${file.name} ${file.path}.age mode=600`),
      ];
      expect(written.join("\n")).toMatchSnapshot();
    });

    it("renders the same quadlet", () => {
      // The catalog, because a deploy renders with it: the derived ordering
      // edges are `After=` lines in the body, and a golden taken without them
      // would pin a unit no deploy writes.
      expect(renderQuadlet(spec, setup?.env, catalog)).toMatchSnapshot();
    });

    it("renders the same route", () => {
      expect(
        proxy.route(spec, {
          domain: house.network.domain,
          publicHosts: house.publicHosts,
          gate: catalog.gate,
        }),
      ).toMatchSnapshot();
    });

    it("prices the same caps on every profile", () => {
      // The drop-in is hashed into the restart trigger beside the quadlet, so a
      // cap that moved is a restart even though the unit runs the same thing.
      expect(
        PROFILES.map((profile) => serviceDropIn(spec.name, profile)).join(""),
      ).toMatchSnapshot();
    });

    for (const file of files) {
      it(`renders the same ${file.name} file`, () => {
        expect(file.content).toMatchSnapshot();
      });
    }

    for (const file of secretFiles) {
      it(`renders the same ${file.name} shape`, () => {
        // Every value the deploy draws stood in for, so the golden pins the
        // file's whole shape and holds no key material: the body is what a
        // review reads, and the values exist only on the board.
        expect(secretFileShape(file)).toMatchSnapshot();
      });
    }
  });
}
