/**
 * Task 8: `GET /search?q=…` — the fixture-backed search service, mounted on
 * the hub (design record §5.2, "Search is a mount, not a process"), gated
 * by `app:search.query`.
 *
 * In process against the hub app, same construction as `admin.test.ts`
 * (`HUB_ACCESS`/`VOCABULARY` from `src/policy.ts`, not `httpeers.core`'s
 * generic library defaults — see that test file's header comment for why).
 * The admin-revokes-then-refused scenario and the 403-with-no-capability
 * scenario are `admin.test.ts`'s job; this file covers the seam itself: the
 * fixture upstream, the missing/empty `q` guard, and that results travel in
 * the body.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemberStore,
  createPeer,
  type Peer,
  RevocationRegistry,
  registerPeer,
} from "@statewalker/httpeers.core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHubEndpoints, usesTransportIdentity } from "../src/hub/endpoints.js";
import { createPersistentHub, type InvitationStore } from "../src/hub/persist.js";
import { HUB_ACCESS, VOCABULARY } from "../src/policy.js";
import { fixtureUpstream, type SearchResult } from "../src/services/search.js";

const MAX_TOKEN_TTL_MS = 5 * 60_000;

interface TestHub {
  peer: Peer;
  invitations: InvitationStore;
}

async function buildHub(stateFilePath: string): Promise<TestHub> {
  const revocations = new RevocationRegistry({ maxTokenTtlMs: MAX_TOKEN_TTL_MS });
  const persistent = createPersistentHub({ filePath: stateFilePath, vocabulary: VOCABULARY, createMemberStore });

  const peer = await createPeer({
    accessTree: HUB_ACCESS,
    vocabulary: VOCABULARY,
    usesTransportIdentity: usesTransportIdentity(),
    // Same wiring as `hub/main.ts` and `admin.test.ts`: the hub enforces
    // revocation on itself via its own live registry, no cache needed.
    revocationCache: revocations,
    mounts: (ctx) =>
      createHubEndpoints({
        selfPeerId: ctx.peerId,
        mintToken: ctx.mintToken,
        memberStore: persistent.memberStore,
        invitations: persistent.invitations,
        vocabulary: VOCABULARY,
        revocations,
      }).mounts,
  });

  return { peer, invitations: persistent.invitations };
}

function requestAs(peerId: string, path: string, init: RequestInit = {}): Request {
  const req = new Request(`http://peer${path}`, init);
  registerPeer(req, peerId);
  return req;
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

describe("Task 8: GET /search", () => {
  let dir: string;
  let hub: TestHub;
  let memberToken: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-search-test-"));
    hub = await buildHub(join(dir, "hub-state.json"));

    hub.invitations.create("MEMBER-CODE", ["member"], 60_000);
    const res = await hub.peer.dispatch(
      requestAs("alice", "/.well-known/invite", { method: "POST", body: JSON.stringify({ id: "MEMBER-CODE" }) }),
    );
    memberToken = ((await res.json()) as { token: string }).token;
  });

  afterEach(async () => {
    await hub.peer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns fixture results for a matching query, in the body", async () => {
    const res = await hub.peer.dispatch(
      requestAs("alice", "/search?q=capabilities", { headers: bearer(memberToken) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { results: SearchResult[] };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]!.title).toMatch(/capabilities/i);
    // The fixture set deliberately carries non-latin1 characters (an
    // accented letter, an emoji) in titles/snippets -- proving they came
    // through the BODY intact is exactly what would fail if a future
    // change tried to hoist a result into a header instead (latin1-only by
    // spec).
    expect(body.results.some((r) => /é|🔍/u.test(r.title) || /é|🔍/u.test(r.snippet))).toBe(true);
  });

  it("a query with no matches returns an empty result set, not an error", async () => {
    const res = await hub.peer.dispatch(
      requestAs("alice", "/search?q=nonexistentxyz", { headers: bearer(memberToken) }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: SearchResult[] }).results).toEqual([]);
  });

  it("a missing q is a 400 with a reason", async () => {
    const res = await hub.peer.dispatch(requestAs("alice", "/search", { headers: bearer(memberToken) }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/q/);
  });

  it("an empty q is a 400 with a reason", async () => {
    const res = await hub.peer.dispatch(requestAs("alice", "/search?q=", { headers: bearer(memberToken) }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/q/);
  });

  it("a whitespace-only q is also a 400, not a query for literal whitespace", async () => {
    const res = await hub.peer.dispatch(requestAs("alice", "/search?q=%20%20", { headers: bearer(memberToken) }));
    expect(res.status).toBe(400);
  });

  it("the fixture upstream itself is deterministic and case-insensitive", async () => {
    const lower = await fixtureUpstream("relay");
    const upper = await fixtureUpstream("RELAY");
    expect(lower).toEqual(upper);
    expect(lower.length).toBeGreaterThan(0);
  });

  it("query strings survive this transport -- no special-casing, no dropped ?q=", async () => {
    // The design record's own note: an earlier finding that `url.search`
    // was dropped in flight was a defect in a library this stack no longer
    // depends on, not something `createSearchEndpoint` guards against. This
    // is exactly the same in-process `peer.dispatch` path every other test
    // in this file uses -- if a `?q=` were silently dropped anywhere on the
    // way in, every other test above would already be failing with a 400.
    const res = await hub.peer.dispatch(
      requestAs("alice", "/search?q=revocation", { headers: bearer(memberToken) }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: SearchResult[] }).results.length).toBeGreaterThan(0);
  });
});
