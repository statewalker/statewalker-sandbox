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

/**
 * Routes the page starts with, so it does something before anyone types.
 *
 * Both measured from a browser origin on 2026-09-11 -- CORS allowed, no key.
 * `/swapi` is a real JSON API to explore. `/httpbin` is the diagnostic one:
 * `/headers` echoes what arrived, proving nothing was stripped, and `/drip`
 * sends bytes spaced over time, which is the falsifiable streaming test --
 * first byte at 0.37s of a 3s response, and anything that buffered would
 * collapse the two together.
 *
 * Note the upstream for swapi is `/api` WITHOUT a trailing slash, and that
 * `https://swapi.dev/api` itself answers 403 while `/api/` answers 200. That
 * is swapi's rule, not this proxy's; it is why the page's examples point at a
 * resource rather than at the bare `/swapi`.
 */
export const DEFAULT_ROUTES: readonly StoredRoute[] = [
  { prefix: "/swapi", upstream: "https://swapi.dev/api", headers: {}, secretHeader: null },
  { prefix: "/httpbin", upstream: "https://httpbin.org", headers: {}, secretHeader: null },
];

/**
 * Stored routes, or `defaults` on a genuine first visit.
 *
 * A FIRST VISIT MEANS THE KEY WAS NEVER WRITTEN, not that the list is empty.
 * Deleting every route writes `[]`, and seeding whenever the list is empty
 * would bring the demo routes back on every reload -- a person could never get
 * rid of them. Likewise content that cannot be parsed is not a first visit:
 * someone wrote it, possibly a newer version of this page, and seeding would
 * overwrite it.
 */
export function loadRoutesOrSeed(
  storage: Pick<Storage, "getItem" | "setItem">,
  defaults: readonly StoredRoute[],
): StoredRoute[] {
  let neverWritten: boolean;
  try {
    neverWritten = storage.getItem(ROUTES_STORAGE_KEY) === null;
  } catch {
    // Storage that refuses to be read cannot be written either; serve the
    // defaults for this session without pretending they were saved.
    return [...defaults];
  }
  if (!neverWritten) return loadRoutes(storage);
  const seeded = [...defaults];
  saveRoutes(storage, seeded);
  return seeded;
}
