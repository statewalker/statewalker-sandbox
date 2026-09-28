/**
 * The proxy's route table: persisted routes, credential values held in
 * memory, and the handler the member mounts at `/proxy`.
 *
 * The routing is `httpeers/apps/demos/src/proxy/main.ts`'s, lifted out of
 * that page's DOM code so it is unit-tested here: a plain Hono router,
 * rebuilt whenever the table changes, where `:rest{.*}` matches on segment
 * boundaries (`/open` does not swallow `/openai`). Credentials are read per
 * request inside `urlUpstream`, so typing one takes effect at once.
 */

import { MARKER } from "@statewalker/webrun-http-proxy";
import { Hono } from "hono";
import { proxyUpstream, rewriteForUpstream } from "./proxy-upstream";
import type { RouteStore, StoredRoute } from "./route-store";

export interface NewRoute {
  prefix: string;
  upstream: string;
  /** The header carrying a credential upstream, e.g. `authorization`. Its name is saved. */
  secretHeader?: string;
  /** That header's value: this session only, never saved. */
  secretValue?: string;
}

export interface ProxyTable {
  /** Reads the stored routes. Call once before `handle`. */
  load(): Promise<void>;
  routes(): StoredRoute[];
  /** Whether a route's credential value was typed this session. */
  hasSecret(prefix: string): boolean;
  /** Adds a route, replacing one with the same prefix. Throws when `validateRoute` refuses it. */
  add(route: NewRoute): Promise<void>;
  remove(prefix: string): Promise<void>;
  /** The mount handler: paths are relative to the mount (`/` lists, `/<prefix>/…` forwards). */
  handle(request: Request): Promise<Response>;
  onChange(listener: () => void): () => void;
}

const SEGMENT = "[A-Za-z0-9._~-]+";
const PREFIX = new RegExp(`^(/${SEGMENT})+$`);

/** Why a route cannot be added, or `undefined` when it can. */
export function validateRoute(prefix: string, upstream: string): string | undefined {
  if (!PREFIX.test(prefix)) {
    return `The prefix must be a path like /api or /api/v1 (letters, digits, . _ ~ -), not ${JSON.stringify(prefix)}.`;
  }
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return `The upstream must be a full URL, not ${JSON.stringify(upstream)}.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `The upstream must be an http or https URL, not ${url.protocol}.`;
  }
  return undefined;
}

export function createProxyTable(init: {
  store: RouteStore;
  fetchImpl?: typeof fetch;
}): ProxyTable {
  let stored: StoredRoute[] = [];
  /** Credential VALUES for this session, by prefix. Never written anywhere. */
  const secrets = new Map<string, { name: string; value: string }>();
  const listeners = new Set<() => void>();
  let router = buildRouter([]);

  function buildRouter(routes: readonly StoredRoute[]): (request: Request) => Promise<Response> {
    const app = new Hono();
    // The listing: prefixes and descriptions, never headers -- a header value may be a credential.
    app.get("/", (c) =>
      c.json({ routes: routes.map((r) => ({ prefix: r.prefix, upstream: r.describe })) }),
    );
    for (const route of routes) {
      const upstream = proxyUpstream(route, secrets.get(route.prefix), init.fetchImpl);
      const forward = async (c: { req: { url: string; raw: Request } }): Promise<Response> => {
        const url = new URL(c.req.url);
        const rest = url.pathname.slice(route.prefix.length) || "/";
        return upstream(await rewriteForUpstream(c.req.raw, `http://upstream${rest}${url.search}`));
      };
      app.all(`${route.prefix}/:rest{.*}`, forward);
      app.all(route.prefix, forward);
    }
    app.notFound(
      () => new Response("no route", { status: 404, headers: { [MARKER]: "no-route" } }),
    );
    return async (request) => app.fetch(request);
  }

  async function commit(next: StoredRoute[]): Promise<void> {
    await init.store.save(next);
    stored = next;
    router = buildRouter(stored);
    for (const listener of listeners) listener();
  }

  return {
    async load() {
      // `undefined` (never written) and `[]` (all deleted) both start empty here: nothing is seeded.
      stored = (await init.store.load()) ?? [];
      router = buildRouter(stored);
    },
    routes: () => stored.map((r) => ({ ...r })),
    hasSecret: (prefix) => secrets.has(prefix),
    async add(route) {
      const problem = validateRoute(route.prefix, route.upstream);
      if (problem != null) throw new Error(problem);
      const secretHeader = route.secretHeader?.trim() || null;
      const next: StoredRoute = {
        prefix: route.prefix,
        upstream: route.upstream,
        describe: route.prefix,
        secretHeader,
      };
      if (secretHeader != null && route.secretValue) {
        secrets.set(route.prefix, { name: secretHeader, value: route.secretValue });
      } else {
        secrets.delete(route.prefix);
      }
      await commit([...stored.filter((r) => r.prefix !== route.prefix), next]);
    },
    async remove(prefix) {
      secrets.delete(prefix);
      await commit(stored.filter((r) => r.prefix !== prefix));
    },
    handle: (request) => router(request),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The request as the table sees it: below `mount`. The member's mount table
 * hands a handler the full path (`/proxy/out/x`), while routes are relative
 * to the mount (`/out/x`, and `/` for the listing). Rebuilt through
 * `rewriteForUpstream`, which carries the body even where the runtime has no
 * `Request.body` (Firefox).
 */
export async function underMount(mount: string, request: Request): Promise<Request> {
  const url = new URL(request.url);
  if (url.pathname === mount || url.pathname.startsWith(`${mount}/`)) {
    url.pathname = url.pathname.slice(mount.length) || "/";
  }
  return rewriteForUpstream(request, url.href);
}
