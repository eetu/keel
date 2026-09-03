/**
 * The render output type. A `Tree` is the complete set of files a host's image
 * contains, keyed by absolute path. Renderers are pure functions from config to
 * `Tree`, which is what lets the invariant tests run without building anything.
 */

export type FileEntry = {
  content: string;
  /** Octal, as systemd and sshd care about it. */
  mode: number;
  /** When set the path is a symlink to this target, and content is unused. */
  symlinkTo?: string;
};

export type Tree = Map<string, FileEntry>;

/** A single-entry tree. Paths must be absolute — the image root is `/`. */
export function file(path: string, content: string, mode = 0o644): Tree {
  if (!path.startsWith("/")) throw new Error(`path must be absolute: ${path}`);
  return new Map([[path, { content, mode }]]);
}

/**
 * A symlink. Used for masking units — a unit symlinked to `/dev/null` cannot be
 * started even as another unit's dependency, which `disable` does not prevent.
 */
export function symlink(path: string, target: string): Tree {
  if (!path.startsWith("/")) throw new Error(`path must be absolute: ${path}`);
  return new Map([[path, { content: "", mode: 0o777, symlinkTo: target }]]);
}

/** An executable file: generators, hooks, anything systemd will exec. */
export function script(path: string, content: string): Tree {
  return file(path, content, 0o755);
}

/**
 * Merge trees, refusing duplicates. Two renderers writing the same path is
 * always a bug — under pyinfra the later `files.put` silently won, and that is
 * exactly the class of surprise this repo exists to remove.
 */
export function merge(...trees: readonly Tree[]): Tree {
  const out: Tree = new Map();
  for (const tree of trees) {
    for (const [path, entry] of tree) {
      if (out.has(path)) throw new Error(`two renderers write ${path}`);
      out.set(path, entry);
    }
  }
  return out;
}

/**
 * Strip the leading indentation a template literal picks up from its
 * surrounding code, so rendered config files are flush-left.
 */
export function dedent(text: string): string {
  const lines = text
    .replace(/^\n/, "")
    .replace(/\n[ \t]*$/, "\n")
    .split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  const strip = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(strip)).join("\n");
}
