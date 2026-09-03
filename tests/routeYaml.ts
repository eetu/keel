/**
 * Reading a rendered route file back.
 *
 * A gated route names two middleware lists — the router's, and the one inside
 * the chain it points at — and the whole bug the chain exists to fix is a router
 * that names the wrong thing. Indentation is what tells them apart, so these
 * read by it rather than by matching a name anywhere in the file.
 */

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

/** The middlewares attached to the router, in the order Traefik applies them. */
export function routerMiddlewares(route: string): string[] {
  return listUnder(route, "      middlewares:", "        ");
}

/** The middlewares the chain expands to, in order. */
export function chainMiddlewares(route: string): string[] {
  return listUnder(route, "        middlewares:", "          ");
}
