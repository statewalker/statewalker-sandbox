/**
 * `GET /search?q=…` — the mesh's first real service, and the shape every
 * later service (image search, a real search backend) follows: a handler
 * plus its `.access` entry (`policy.ts`'s `"/search"`) plus, on a provider,
 * an advertisement — see the design record §5.2, "Search is a mount, not a
 * process."
 *
 * THE SEAM. `SearchUpstream` is the entire contract between this handler
 * and wherever results actually come from. `fixtureUpstream` below is the
 * only implementation this task ships — no network egress, deterministic,
 * safe to run in a test with no external dependency — but the handler
 * itself (`createSearchEndpoint`) never learns that: swapping in a real
 * backend later is a change to what gets passed as `upstream`, not to
 * `createSearchEndpoint` or to `policy.ts`'s `.access` entry.
 *
 * RESULTS GO IN THE BODY, NEVER IN A HEADER. HTTP header values are latin1
 * by specification (RFC 7230 §3.2, and enforced in practice by the Fetch
 * `Headers` implementation every runtime here uses) — a title or snippet
 * containing anything outside that range (an emoji, a curly quote, café's
 * `é`) throws or is mangled before the request ever reaches the wire. This
 * has bitten this project before; the fixture set deliberately carries a
 * couple of such characters (see `search-fixtures.json`) so a regression
 * that tried to hoist a result into a header would fail loudly, not
 * silently pass on ASCII-only fixtures.
 *
 * QUERY STRINGS WORK ON THIS TRANSPORT. An earlier finding that `url.search`
 * was dropped in flight was a defect in a library this stack no longer
 * depends on (`hub/endpoints.ts`'s own module comment explains why its
 * *conditional-read* endpoints use `ETag`/`If-None-Match` instead of
 * `?since=` regardless — that is a design preference, not a workaround for
 * a transport limitation). `GET /search` reads `q` from the ordinary
 * request URL with no fallback and no guard.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FetchHandler } from "@statewalker/httpeers.core";
import { json } from "@statewalker/httpeers.core";
import { Hono } from "hono";

export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  url: string;
}

export type SearchUpstream = (query: string) => Promise<SearchResult[]>;

const fixturesPath = fileURLToPath(new URL("./search-fixtures.json", import.meta.url));
const FIXTURES: SearchResult[] = JSON.parse(readFileSync(fixturesPath, "utf8"));

/**
 * Case-insensitive substring match over `title` and `snippet`. Deterministic
 * (no ranking, no randomness) and dependency-free — exactly enough to prove
 * the seam end to end, not a search engine.
 */
export const fixtureUpstream: SearchUpstream = async (query) => {
  const needle = query.toLowerCase();
  return FIXTURES.filter(
    (r) => r.title.toLowerCase().includes(needle) || r.snippet.toLowerCase().includes(needle),
  );
};

export interface SearchEndpointInit {
  upstream: SearchUpstream;
}

/** `GET /search?q=…`. A missing or empty `q` is a 400 with a reason; capability gating is `policy.ts`'s job, not this handler's. */
export function createSearchEndpoint(init: SearchEndpointInit): FetchHandler {
  const app = new Hono();

  app.get("/search", async (c) => {
    const q = c.req.query("q");
    if (q == null || q.trim() === "") {
      return json({ error: "q is required and must not be empty" }, 400);
    }
    const results = await init.upstream(q);
    return json({ results });
  });

  return app.fetch as FetchHandler;
}
