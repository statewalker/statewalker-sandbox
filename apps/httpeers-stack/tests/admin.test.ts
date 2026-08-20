/**
 * Task 8: `DELETE /admin/members/{peerId}`, and the end-to-end proof that
 * admin revocation, the hub's own endpoints, and `httpeers.core`'s existing
 * 304-on-unchanged-version endpoints all still connect correctly once this
 * app's own vocabulary/`.access` tree (`src/policy.ts`) is wired in.
 *
 * IN-PROCESS, LIKE `hub.test.ts`, NOT REAL LIBP2P LIKE `revocation-e2e
 * .test.ts`. This suite's revoked-member scenario needs no dialed
 * connection or real heartbeat round trip: the member calling `/search`
 * IS calling the hub directly (the design record's own choice — "Search is
 * a mount, not a process," §5.2), so there is no separate provider process
 * to pull a deny-list from. `buildHub`'s `revocationCache: revocations`
 * (passed straight to `createPeer`, same as `hub/main.ts`'s production
 * wiring) is what makes that enforcement REAL here: `httpeers.core`'s
 * binding middleware (`peer-handlers.ts`) calls `isRevoked` on every
 * non-bootstrap request, before ANY mount's handler runs — this is one
 * mechanism applied hub-wide, not a check bolted onto one route. See
 * `RevocationRegistry.check` (`httpeers.core/src/revocation.ts`) for why
 * the hub needs no cache and no pull to use it: it owns the registry.
 *
 * `buildHub` below is deliberately NOT `tests/support/mesh.ts`'s
 * `buildTestHub` — that helper (and `hub.test.ts`'s own local `buildHub`,
 * which this one is modeled on) wires `DEFAULT_ACCESS_TREE`/
 * `DEFAULT_VOCABULARY`, the library's generic defaults, unchanged by this
 * task on purpose (see `policy.ts`'s module comment). This suite wires
 * `HUB_ACCESS`/`VOCABULARY` instead — this app's own policy, the one
 * `hub/main.ts`'s production peer actually runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberStore } from "@statewalker/httpeers.core";
import {
  createMemberStore,
  createMonotonicClock,
  createPeer,
  type Peer,
  RevocationRegistry,
  registerPeer,
} from "@statewalker/httpeers.core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHubEndpoints, usesTransportIdentity } from "../src/hub/endpoints.js";
import { createPersistentHub, type InvitationStore } from "../src/hub/persist.js";
import { HUB_ACCESS, VOCABULARY } from "../src/policy.js";

const PRESENCE_TTL_MS = 15_000;
const MAX_TOKEN_TTL_MS = 5 * 60_000;

interface TestHub {
  peer: Peer;
  memberStore: MemberStore;
  invitations: InvitationStore;
  revocations: RevocationRegistry;
}

async function buildHub(stateFilePath: string): Promise<TestHub> {
  // ONE shared clock for minting AND the revocation registry -- see
  // `revocation.ts`'s "ONE HUB-ISSUED CLOCK, NOT TWO". This suite mints a
  // token then revokes it moments later (in-process, no dialed round trip,
  // so the gap can be well under a millisecond); two independent `Date.now`
  // defaults can tie, a shared monotonic clock cannot.
  const clock = createMonotonicClock();
  const revocations = new RevocationRegistry({ maxTokenTtlMs: MAX_TOKEN_TTL_MS, now: clock });
  const persistent = createPersistentHub({
    filePath: stateFilePath,
    vocabulary: VOCABULARY,
    createMemberStore,
  });

  const peer = await createPeer({
    accessTree: HUB_ACCESS,
    vocabulary: VOCABULARY,
    usesTransportIdentity: usesTransportIdentity(),
    now: clock,
    // Same instance `createHubEndpoints` below bumps on DELETE
    // /admin/members/{id} -- the hub enforcing revocation against its OWN
    // live registry, no cache, no pull. See the module comment.
    revocationCache: revocations,
    mounts: (ctx) =>
      createHubEndpoints({
        selfPeerId: ctx.peerId,
        mintToken: ctx.mintToken,
        memberStore: persistent.memberStore,
        invitations: persistent.invitations,
        vocabulary: VOCABULARY,
        revocations,
        presenceTtlMs: PRESENCE_TTL_MS,
      }).mounts,
  });

  return {
    peer,
    memberStore: persistent.memberStore,
    invitations: persistent.invitations,
    revocations,
  };
}

function requestAs(peerId: string, path: string, init: RequestInit = {}): Request {
  const req = new Request(`http://peer${path}`, init);
  registerPeer(req, peerId);
  return req;
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function invite(
  hub: TestHub,
  peerId: string,
  code: string,
  roles: string[],
): Promise<string> {
  hub.invitations.create(code, roles, 60_000);
  const res = await hub.peer.dispatch(
    requestAs(peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id: code }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

describe("Task 8: admin revocation and the search mount", () => {
  let dir: string;
  let hub: TestHub;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-admin-test-"));
    hub = await buildHub(join(dir, "hub-state.json"));
  });

  afterEach(async () => {
    await hub.peer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("an admin revokes a member; that member's next /search is refused, with a reason naming revocation -- within one heartbeat", async () => {
    const adminToken = await invite(hub, "root-admin", "ADMIN-CODE", ["admin"]);
    const bobToken = await invite(hub, "bob", "BOB-CODE", ["member"]);

    // Bob can search before revocation.
    const before = await hub.peer.dispatch(
      requestAs("bob", "/search?q=relay", { headers: bearer(bobToken) }),
    );
    expect(before.status).toBe(200);
    expect(((await before.json()) as { results: unknown[] }).results.length).toBeGreaterThan(0);

    // The admin revokes bob over the endpoint this task adds.
    const t0 = Date.now();
    const del = await hub.peer.dispatch(
      requestAs("root-admin", "/admin/members/bob", {
        method: "DELETE",
        headers: bearer(adminToken),
      }),
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ ok: true, removed: "bob" });

    // Bob's NEXT /search call, with the SAME (still cryptographically
    // valid, unexpired) token he already held -- no intervening
    // heartbeat, no fresh token -- is refused, and the reason names
    // revocation.
    const after = await hub.peer.dispatch(
      requestAs("bob", "/search?q=relay", { headers: bearer(bobToken) }),
    );
    const elapsed = Date.now() - t0;
    expect(after.status).toBe(403);
    expect(((await after.json()) as { error: string }).error).toMatch(/revoked/);
    // Bounded, not merely eventual: well under one heartbeat interval.
    expect(elapsed).toBeLessThan(PRESENCE_TTL_MS);

    // NOT route-scoped: the SAME token, still on the SAME hub, is refused
    // on a completely different mount too (`/.well-known/mesh`) -- proof
    // the enforcement is the binding middleware's `isRevoked`, applied
    // uniformly before any handler runs, not a check that happens to live
    // on `/search`.
    const meshAfter = await hub.peer.dispatch(
      requestAs("bob", "/.well-known/mesh", { headers: bearer(bobToken) }),
    );
    expect(meshAfter.status).toBe(403);
    expect(((await meshAfter.json()) as { error: string }).error).toMatch(/revoked/);

    // The member registry itself no longer lists bob.
    expect(hub.memberStore.list().map((m) => m.peerId)).not.toContain("bob");
    // And the policy version moved -- what makes a REMOTE provider's next
    // pulled heartbeat see the same change (revocation-e2e.test.ts's E3/E4).
    expect(hub.revocations.policyVersion()).toBeGreaterThan(1);
  }, 20_000);

  it("a revoked admin cannot call DELETE /admin/members/... -- the case that justifies enforcing hub-wide, not route by route", async () => {
    const rootToken = await invite(hub, "root-admin", "ROOT-CODE", ["admin"]);
    const badActorToken = await invite(hub, "bad-actor", "BAD-ACTOR-CODE", ["admin"]);
    await invite(hub, "carol", "CAROL-CODE", ["member"]);

    // The root admin revokes the misbehaving admin's OWN membership --
    // exactly the scenario note 34 §8 exists to prevent from being
    // impossible: an admin removed for cause must not be able to keep
    // acting as one on their old token.
    const del = await hub.peer.dispatch(
      requestAs("root-admin", "/admin/members/bad-actor", {
        method: "DELETE",
        headers: bearer(rootToken),
      }),
    );
    expect(del.status).toBe(200);

    // bad-actor tries to remove carol with the SAME, still-valid,
    // still-"admin"-role-carrying token they already held.
    const res = await hub.peer.dispatch(
      requestAs("bad-actor", "/admin/members/carol", {
        method: "DELETE",
        headers: bearer(badActorToken),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/revoked/);

    // Refused before the handler ever ran: carol is still a member.
    expect(hub.memberStore.get("carol")).toBeDefined();
  });

  it("a member calling DELETE /admin/... is refused 403, and the reason names the missing capability", async () => {
    const bobToken = await invite(hub, "bob", "BOB-CODE", ["member"]);
    await invite(hub, "carol", "CAROL-CODE", ["member"]);

    const res = await hub.peer.dispatch(
      requestAs("bob", "/admin/members/carol", { method: "DELETE", headers: bearer(bobToken) }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/std:mesh\.admin/);

    // Refused before the handler ever ran: carol is still a member.
    expect(hub.memberStore.get("carol")).toBeDefined();
  });

  it("/search without app:search.query -> 403 carrying the tree's reason", async () => {
    // A real, current, unrevoked member (so token verification and the
    // isRevoked check both pass) whose token simply carries no role that
    // confers `app:search.query` -- the ordinary capability check, not the
    // bootstrap/no-token case (that's `newPeerHandlers`' own 401, a
    // different layer, already covered by `hub.test.ts`'s "a caller with no
    // proven identity cannot reach a bootstrap path").
    const noRoleToken = await invite(hub, "roleless", "ROLELESS-CODE", []);

    const res = await hub.peer.dispatch(
      requestAs("roleless", "/search?q=relay", { headers: bearer(noRoleToken) }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/app:search\.query/);
  });

  it("the vocabulary and revocation endpoints still answer 304 on an unchanged version", async () => {
    const bobToken = await invite(hub, "bob", "BOB-CODE", ["member"]);

    const vocabFirst = await hub.peer.dispatch(
      requestAs("bob", "/.well-known/vocabulary", { headers: bearer(bobToken) }),
    );
    expect(vocabFirst.status).toBe(200);
    const vocabEtag = vocabFirst.headers.get("etag");
    expect(vocabEtag).toBeTruthy();
    const vocabSecond = await hub.peer.dispatch(
      requestAs("bob", "/.well-known/vocabulary", {
        headers: { ...bearer(bobToken), "if-none-match": vocabEtag! },
      }),
    );
    expect(vocabSecond.status).toBe(304);

    const revFirst = await hub.peer.dispatch(
      requestAs("bob", "/.well-known/revocations", { headers: bearer(bobToken) }),
    );
    expect(revFirst.status).toBe(200);
    const revEtag = revFirst.headers.get("etag");
    expect(revEtag).toBeTruthy();
    const revSecond = await hub.peer.dispatch(
      requestAs("bob", "/.well-known/revocations", {
        headers: { ...bearer(bobToken), "if-none-match": revEtag! },
      }),
    );
    expect(revSecond.status).toBe(304);
  });
});
