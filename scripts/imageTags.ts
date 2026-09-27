/**
 * The pure half of `yarn update`: finding digest pins in a catalog's source and
 * choosing the version a pin could move to.
 */

/** A digest-pinned image reference as it is spelled in a catalog's source. */
export type Pin = {
  /** The whole quoted reference, which is what a bump replaces. */
  ref: string;
  repo: string;
  /** Absent for a pin written as `repo@sha256:…`. */
  tag?: string;
  digest: string;
};

const PIN = /"([a-z0-9.\-/]+)(?::([\w][\w.-]*))?@(sha256:[0-9a-f]{64})"/g;

/**
 * Every digest pin in `source`, once each. A tag with no digest is a branch an
 * image is built from, resolved at deploy time, and not a version to move.
 */
export function findPins(source: string): Pin[] {
  const pins = new Map<string, Pin>();
  for (const [, repo, tag, digest] of source.matchAll(PIN)) {
    const ref = tag === undefined ? `${repo}@${digest}` : `${repo}:${tag}@${digest}`;
    pins.set(ref, { ref, repo: repo!, ...(tag === undefined ? {} : { tag }), digest: digest! });
  }
  return [...pins.values()];
}

/**
 * A tag with its numbers masked. Two tags are versions of one series only when
 * the rest matches, so `1.2.3-alpine` never moves to `1.3.0`, and a release never
 * moves to `1.3.0-rc1` or to `sha-ffe9419`.
 */
const shape = (tag: string): string => tag.replace(/\d+/g, "#");

const numbers = (tag: string): number[] => (tag.match(/\d+/g) ?? []).map(Number);

/** Numeric, not lexical: `v0.10.0` is newer than `v0.9.9`. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** A plain release number, the only shape a tag-less pin is matched against. */
export const isRelease = (tag: string): boolean => /^v?\d+(\.\d+){1,3}$/.test(tag);

/** The newest tag in `current`'s series, or undefined when nothing is newer. */
export function newerTag(tags: readonly string[], current: string): string | undefined {
  const series = tags.filter((tag) => shape(tag) === shape(current));
  const newest = series.sort(compareVersions).at(-1);
  return newest !== undefined && compareVersions(newest, current) > 0 ? newest : undefined;
}

/**
 * Release tags, newest first — the order a tag-less pin's version is searched
 * in. On a tie the longer tag comes first, so a pin is named `0.19.0` rather
 * than the `0.19` that floats along with it.
 */
export const releasesNewestFirst = (tags: readonly string[]): string[] =>
  tags
    .filter(isRelease)
    .sort((a, b) => compareVersions(b, a) || numbers(b).length - numbers(a).length);
