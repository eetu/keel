/**
 * Reading a rendered route file back.
 *
 * A gated route names two middleware lists — the router's, and the one inside
 * the chain it points at — and the whole bug the chain exists to fix is a router
 * that names the wrong thing. Indentation is what tells them apart, so these
 * read by it rather than by matching a name anywhere in the file.
 *
 * A vhost may carry more than one router, so what a router carries is read per
 * router: a rule that holds only for the first one would pass a file whose
 * second router answers the same host with none of its middlewares.
 */

/** One router as the file spells it: what it matches, where it sits, what it carries. */
export type ParsedRouter = {
  rule: string;
  priority?: number;
  middlewares: string[];
};

/** The lines under a top-level key, up to the next key at the same indent. */
function block(route: string, header: string): string[] {
  const lines = route.split("\n");
  const start = lines.indexOf(header);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

function listUnder(route: string, header: string, indent: string): string[] {
  const lines = route.split("\n");
  const start = lines.indexOf(header);
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(`${indent}- `)) break;
    items.push(line.slice(indent.length + 2));
  }
  return items;
}

/** Every router in the file, by name. */
export function routersOf(route: string): Record<string, ParsedRouter> {
  const found: Record<string, ParsedRouter> = {};
  let current: ParsedRouter | undefined;
  let inMiddlewares = false;
  for (const line of block(route, "  routers:")) {
    const named = /^ {4}([\w-]+):$/.exec(line);
    if (named !== null) {
      current = { rule: "", middlewares: [] };
      found[named[1]] = current;
      inMiddlewares = false;
      continue;
    }
    if (current === undefined) continue;
    const rule = /^ {6}rule: "(.*)"$/.exec(line);
    if (rule !== null) {
      current.rule = rule[1];
      continue;
    }
    const priority = /^ {6}priority: (\d+)$/.exec(line);
    if (priority !== null) {
      current.priority = Number(priority[1]);
      continue;
    }
    if (line === "      middlewares:") {
      inMiddlewares = true;
      continue;
    }
    if (inMiddlewares && line.startsWith("        - ")) {
      current.middlewares.push(line.slice("        - ".length));
      continue;
    }
    inMiddlewares = false;
  }
  return found;
}

/** Every load balancer in the file, by name, with the one URL it forwards to. */
export function servicesOf(route: string): Record<string, string> {
  const found: Record<string, string> = {};
  let current: string | undefined;
  for (const line of block(route, "  services:")) {
    const named = /^ {4}([\w-]+):$/.exec(line);
    if (named !== null) {
      current = named[1];
      found[current] = "";
      continue;
    }
    const url = /^ {10}- url: "(.*)"$/.exec(line);
    if (url !== null && current !== undefined) found[current] = url[1];
  }
  return found;
}

/** The middlewares attached to the first router, in the order Traefik applies them. */
export function routerMiddlewares(route: string): string[] {
  return Object.values(routersOf(route))[0]?.middlewares ?? [];
}

/** The middlewares the chain expands to, in order. */
export function chainMiddlewares(route: string): string[] {
  return listUnder(route, "        middlewares:", "          ");
}
