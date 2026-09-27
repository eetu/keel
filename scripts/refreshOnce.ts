/**
 * `up --refresh` reads every resource on the board twice: once in the preview
 * and again in the update after the confirmation, which does not reuse the
 * preview's reads. On a board where a refresh is the heaviest thing a deploy
 * does, that is the whole cost paid twice to guard the seconds between a plan
 * and a "yes". So `up` with a refresh becomes a refresh applied without its own
 * preview — one read pass, which rewrites state and never the board — and then
 * an `up` without one, whose plan is against the state just read and is still
 * what is confirmed. The last `--refresh` wins, so `--refresh=false` still means
 * no refresh at all.
 */
export function splitRefresh(args: readonly string[]): { refresh: string[]; up: string[] } | null {
  if (args[0] !== "up") return null;
  const flags = args.filter((arg) => arg === "--refresh" || arg.startsWith("--refresh="));
  const last = flags.at(-1);
  if (last === undefined || last === "--refresh=false") return null;
  const kept = (name: string, short?: string): string[] => {
    const at = args.findIndex((arg) => arg === name || arg === short);
    return at === -1 ? [] : [args[at]!, args[at + 1]!];
  };
  return {
    refresh: [
      "refresh",
      "--skip-preview",
      "--yes",
      ...kept("--stack", "-s"),
      ...kept("--parallel"),
    ],
    up: args.filter((arg) => !flags.includes(arg)),
  };
}
