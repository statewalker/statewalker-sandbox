/**
 * Task 8: `DELETE /admin/members/{peerId}`, and the end-to-end proof that
 * admin revocation, `/search`, and `httpeers.core`'s existing 304-on-
 * unchanged-version endpoints all still connect correctly once this app's
 * own vocabulary/`.access` tree (`src/policy.ts`) is wired in.
 *
 * IN-PROCESS, LIKE `hub.test.ts`, NOT REAL LIBP2P LIKE `revocation-e2e
 * .test.ts`. This suite's revoked-member scenario needs no dialed
 * connection or real heartbeat round trip: the member calling `/search`
 * IS calling the hub directly (the design record's own choice — "Search is
 * a mount, not a process," §5.2), so there is no separate provider process
 * to pull a deny-list from. `hub/endpoints.ts`'s `requireCurrentMembership`
 * wrapper on `/search` checks this hub's own live `memberStore` directly —
 * see that file's comment for why that is correct specifically because
 * this handler runs on the hub, which holds the source of truth, not a
 * pulled copy of it.
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
  const revocations = new RevocationRegistry({ maxTokenTtlMs: MAX_TOKEN_TTL_MS });
  const persistent = createPersistentHub({
    filePath: stateFilePath,
    vocabulary: VOCABULARY,
    createMemberStore,
  });

  const peer = await createPeer({
    accessTree: HUB_ACCESS,
    vocabulary: VOCABULARY,
    usesTransportIdentity: usesTransportIdentity(),
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

  return { peer, memberStore: persistent.memberStore, invitations: persistent.invitations, revocations };
}

function requestAs(peerId: string, path: string, init: RequestInit = {}): Request {
  const req = new Request(`http://peer${path}`, init);
  registerPeer(req, peerId);
  return req;
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function invite(hub: TestHub, peerId: string, code: string, roles: string[]): Promise<string> {
  hub.invitations.create(code, roles, 60_000);
  const res = await hub.peer.dispatch(
    requestAs(peerId, "/.well-known/invite", { method: "POST", body: JSON.stringify({ id: code }) }),
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

  it(
    "an admin revokes a member; that member's next /search is refused, with a reason naming revocation -- within one heartbeat",
    async () => {
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
        requestAs("root-admin", "/admin/members/bob", { method: "DELETE", headers: bearer(adminToken) }),
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

      // The member registry itself no longer lists bob.
      expect(hub.memberStore.list().map((m) => m.peerId)).not.toContain("bob");
      // And the policy version moved -- what makes a REMOTE provider's next
      // pulled heartbeat see the same change (revocation-e2e.test.ts's E3/E4).
      expect(hub.revocations.policyVersion()).toBeGreaterThan(1);
    },
    20_000,
  );

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
    // A real, current member (so `requireCurrentMembership` and token
    // verification both pass) whose token simply carries no role that
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
