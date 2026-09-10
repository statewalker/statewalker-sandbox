/**
 * What survives a reload, and what deliberately does not.
 *
 * Routes are worth keeping -- retyping an upstream and its prefix every time
 * would make the page unusable. Tokens are not: a bearer key in
 * `localStorage` outlives the session, the tab and the person's attention, and
 * this page is reachable by every member of the mesh.
 *
 * So the split is by ownership: the SERVICE takes plain headers and knows
 * nothing about secrets, and this module decides what is written down. A
 * route records the NAME of its auth header; the value lives in memory for as
 * long as the page is open.
 */
import type { ProxyRoute } from "../../services/proxy-routes.js";

export const ROUTES_STORAGE_KEY = "httpeers.proxy.routes.v1";

export interface StoredRoute {
  prefix: string;
  upstream: string;
  /** Non-secret headers, persisted as they are. */
  headers: Record<string, string>;
  /** Name of the header whose value is NOT persisted, or `null`. */
  secretHeader: string | null;
}

function isStoredRoute(value: unknown): value is StoredRoute {
  if (value == null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.prefix === "string" &&
    typeof r.upstream === "string" &&
    typeof r.headers === "object" && r.headers !== null &&
    (r.secretHeader === null || typeof r.secretHeader === "string")
  );
}

/** Stored routes, or an empty list. Never throws: storage is shared with other tabs, older versions of this page, and the user. */
export function loadRoutes(storage: Pick<Storage, "getItem">): StoredRoute[] {
  try {
    const raw = storage.getItem(ROUTES_STORAGE_KEY);
    if (raw == null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isStoredRoute)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function saveRoutes(storage: Pick<Storage, "setItem">, routes: readonly StoredRoute[]): void {
  try {
    storage.setItem(ROUTES_STORAGE_KEY, JSON.stringify(routes));
  } catch {
    // A full or blocked storage must not lose the routes the page is already
    // serving; they stay live for this session.
  }
}

/** Stored routes plus the secrets entered this session, ready for `createProxyEndpoint`. */
export function withSecrets(
  routes: readonly StoredRoute[],
  secrets: ReadonlyMap<string, string>,
): ProxyRoute[] {
  return routes.map((route) => {
    const headers = { ...route.headers };
    const secret = route.secretHeader != null ? secrets.get(route.prefix) : undefined;
    if (route.secretHeader != null && secret != null && secret !== "") {
      headers[route.secretHeader] = secret;
    }
    return { prefix: route.prefix, upstream: route.upstream, headers };
  });
}
