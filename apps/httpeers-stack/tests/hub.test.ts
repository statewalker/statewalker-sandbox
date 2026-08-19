/**
 * Task 7a, Step 8b: the hub's endpoints, in process, no network.
 *
 * `createPeer` still builds a real (but dial-only, unlisted) libp2p node —
 * it needs one to hold a real Ed25519 signing key, which is what makes
 * `mintToken`/`verifyToken`'s self-certification real rather than faked.
 * Nothing here dials it, though: every simulated caller is a plain string
 * peerId, registered on a manufactured `Request` via `registerPeer` exactly
 * the way `serveTransport`'s per-stream closure would, then handed straight
 * to `peer.dispatch` — the composed router `serveTransport` would otherwise
 * call. That is "mount the hub app and call `app.fetch` directly": no
 * socket, no dial, but the real production wiring (mounts factory, binding,
 * access tree, router, hub endpoints) end to end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberStore } from "@statewalker/httpeers.core";
import {
  createMemberStore,
  createPeer,
  DEFAULT_ACCESS_TREE,
  DEFAULT_VOCABULARY,
  type Peer,
  RevocationRegistry,
  registerAnonymous,
  registerPeer,
} from "@statewalker/httpeers.core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHubEndpoints, usesTransportIdentity } from "../src/hub/endpoints.js";
import {
  createPersistentHub,
  type InvitationStore,
  type PersistentHub,
} from "../src/hub/persist.js";

const PRESENCE_TTL_MS = 15_000;
const MAX_TOKEN_TTL_MS = 5 * 60_000;

interface TestHub {
  peer: Peer;
  memberStore: MemberStore;
  invitations: InvitationStore;
  sweep: () => void;
  stateFilePath: string;
  clock: { now: number };
}

async function buildHub(opts: {
  stateFilePath: string;
  clock: { now: number };
  advertisementAccess?: Record<string, string>;
}): Promise<TestHub> {
  const now = () => opts.clock.now;
  const vocabulary = DEFAULT_VOCABULARY;
  const revocations = new RevocationRegistry({ maxTokenTtlMs: MAX_TOKEN_TTL_MS, now });

  const persistent: PersistentHub = createPersistentHub({
    filePath: opts.stateFilePath,
    vocabulary,
    now,
    createMemberStore,
  });

  let sweep: (() => void) | undefined;

  const peer = await createPeer({
    accessTree: DEFAULT_ACCESS_TREE,
    vocabulary,
    usesTransportIdentity: usesTransportIdentity(),
    now,
    mounts: (ctx) => {
      const hub = createHubEndpoints({
        selfPeerId: ctx.peerId,
        mintToken: ctx.mintToken,
        memberStore: persistent.memberStore,
        invitations: persistent.invitations,
        vocabulary,
        revocations,
        now,
        presenceTtlMs: PRESENCE_TTL_MS,
        advertisementAccess: opts.advertisementAccess,
      });
      sweep = hub.sweep;
      return hub.mounts;
    },
  });

  if (sweep == null) throw new Error("mounts factory did not run");

  return {
    peer,
    memberStore: persistent.memberStore,
    invitations: persistent.invitations,
    sweep,
    stateFilePath: opts.stateFilePath,
    clock: opts.clock,
  };
}

/** Manufacture a request with a transport-proven identity, the way `serveTransport` would register one per inbound stream. */
function requestAs(peerId: string, path: string, init: RequestInit = {}): Request {
  const req = new Request(`http://peer${path}`, init);
  registerPeer(req, peerId);
  return req;
}

function anonymousRequest(path: string, init: RequestInit = {}): Request {
  const req = new Request(`http://peer${path}`, init);
  registerAnonymous(req);
  return req;
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function json(res: Response): Promise<any> {
  return res.json();
}

describe("hub: invite, presence and the mesh view", () => {
  let dir: string;
  let clock: { now: number };
  let hub: TestHub;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-hub-test-"));
    clock = { now: 1_000_000 };
    hub = await buildHub({ stateFilePath: join(dir, "hub-state.json"), clock });
  });

  afterEach(async () => {
    await hub.peer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("invite -> token -> presence -> the peer appears in the mesh view", async () => {
    hub.invitations.create("INV-ALICE", ["member"], 60_000);

    const inviteRes = await hub.peer.dispatch(
      requestAs("alice", "/.well-known/invite", {
        method: "POST",
        body: JSON.stringify({ id: "INV-ALICE" }),
      }),
    );
    expect(inviteRes.status).toBe(200);
    const inviteBody = await json(inviteRes);
    expect(inviteBody.token).toEqual(expect.any(String));
    expect(inviteBody.roles).toEqual(["member"]);

    const presenceRes = await hub.peer.dispatch(
      requestAs("alice", "/.well-known/presence", {
        method: "POST",
        body: JSON.stringify({ seq: 1, addrs: ["/ip4/127.0.0.1/tcp/4001"] }),
      }),
    );
    expect(presenceRes.status).toBe(200);
    const presenceBody = await json(presenceRes);
    const token = presenceBody.token as string;

    const meshRes = await hub.peer.dispatch(
      requestAs("alice", "/.well-known/mesh", { headers: bearer(token) }),
    );
    expect(meshRes.status).toBe(200);
    const view = await json(meshRes);
    expect(view.members).toContainEqual({
      peerId: "alice",
      roles: ["member"],
      online: true,
      addrs: ["/ip4/127.0.0.1/tcp/4001"],
    });
  });

  it("an invitation id cannot be redeemed twice, including across a persist/reload cycle", async () => {
    hub.invitations.create("INV-ONE-SHOT", ["member"], 60_000);

    const first = await hub.peer.dispatch(
      requestAs("alice", "/.well-known/invite", {
        method: "POST",
        body: JSON.stringify({ id: "INV-ONE-SHOT" }),
      }),
    );
    expect(first.status).toBe(200);

    // Same running hub: a second redemption is refused.
    const second = await hub.peer.dispatch(
      requestAs("alice", "/.well-known/invite", {
        method: "POST",
        body: JSON.stringify({ id: "INV-ONE-SHOT" }),
      }),
    );
    expect(second.status).toBe(403);
    expect((await json(second)).error).toMatch(/already-redeemed/);

    // Reload: a FRESH hub over the SAME snapshot file must remember the spend
    // even though the invitation record itself was never persisted.
    await hub.peer.stop();
    const reloaded = await buildHub({ stateFilePath: hub.stateFilePath, clock });
    try {
      const afterReload = await reloaded.peer.dispatch(
        requestAs("bob", "/.well-known/invite", {
          method: "POST",
          body: JSON.stringify({ id: "INV-ONE-SHOT" }),
        }),
      );
      expect(afterReload.status).toBe(403);
      expect((await json(afterReload)).error).toMatch(/already-redeemed/);

      // And membership itself survived the restart -- alice is still a member.
      const members = reloaded.memberStore.list();
      expect(members.map((m) => m.peerId)).toContain("alice");
    } finally {
      await reloaded.peer.stop();
    }
  });

  it("a role name that is not in the vocabulary is rejected at createInvitation, not at first use", () => {
    expect(() => hub.invitations.create("INV-BAD-ROLE", ["superadmin"], 60_000)).toThrow(
      /unknown role 'superadmin'/,
    );
  });

  it("a role name that is not in the vocabulary is rejected at MemberStore.setRoles too — the guard lives at the store, not at whichever call site exists today", async () => {
    hub.invitations.create("INV-GRACE", ["member"], 60_000);
    await hub.peer.dispatch(
      requestAs("grace", "/.well-known/invite", { method: "POST", body: JSON.stringify({ id: "INV-GRACE" }) }),
    );

    expect(() => hub.memberStore.setRoles("grace", ["superadmin"])).toThrow(/unknown role 'superadmin'/);
    // Rejected before the write: grace's roles are unchanged.
    expect(hub.memberStore.get("grace")?.roles).toEqual(["member"]);
  });

  it("check-in returns { token, versions } and not the roster", async () => {
    hub.invitations.create("INV-CAROL", ["member"], 60_000);
    await hub.peer.dispatch(
      requestAs("carol", "/.well-known/invite", {
        method: "POST",
        body: JSON.stringify({ id: "INV-CAROL" }),
      }),
    );

    const res = await hub.peer.dispatch(
      requestAs("carol", "/.well-known/presence", {
        method: "POST",
        body: JSON.stringify({ seq: 1, addrs: [] }),
      }),
    );
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(["token", "versions"]);
    expect(body.versions).toEqual({
      mesh: expect.any(Number),
      policy: expect.any(Number),
      vocabulary: expect.any(Number),
    });
  });

  it("the mesh view is filtered by capability: a caller lacking one does not see the advertisement it gates", async () => {
    const gated = await buildHub({
      stateFilePath: join(dir, "gated-state.json"),
      clock,
      advertisementAccess: { "app:special": "std:mesh.admin" },
    });
    try {
      gated.invitations.create("INV-PROVIDER", ["member"], 60_000);
      gated.invitations.create("INV-ADMIN", ["admin"], 60_000);

      const providerInvite = await gated.peer.dispatch(
        requestAs("provider", "/.well-known/invite", {
          method: "POST",
          body: JSON.stringify({ id: "INV-PROVIDER" }),
        }),
      );
      const providerToken = (await json(providerInvite)).token as string;

      const adminInvite = await gated.peer.dispatch(
        requestAs("admin-bob", "/.well-known/invite", {
          method: "POST",
          body: JSON.stringify({ id: "INV-ADMIN" }),
        }),
      );
      const adminToken = (await json(adminInvite)).token as string;

      // The provider advertises a gated service on its heartbeat.
      await gated.peer.dispatch(
        requestAs("provider", "/.well-known/presence", {
          method: "POST",
          body: JSON.stringify({
            seq: 1,
            addrs: ["/ip4/127.0.0.1/tcp/5000"],
            advertisements: [{ id: "svc", kind: "app:special", title: "Special Service" }],
          }),
        }),
      );

      // The invite response's token is itself a valid member-scoped token --
      // the provider does not need a second heartbeat to read the view.
      const asMember = await gated.peer.dispatch(
        requestAs("provider", "/.well-known/mesh", { headers: bearer(providerToken) }),
      );
      expect((await json(asMember)).advertisements).toEqual([]);

      const asAdmin = await gated.peer.dispatch(
        requestAs("admin-bob", "/.well-known/mesh", { headers: bearer(adminToken) }),
      );
      expect((await json(asAdmin)).advertisements).toEqual([
        { peerId: "provider", id: "svc", kind: "app:special", title: "Special Service" },
      ]);
    } finally {
      await gated.peer.stop();
    }
  });

  it("an unchanged view plus If-None-Match returns 304", async () => {
    hub.invitations.create("INV-DAN", ["member"], 60_000);
    await hub.peer.dispatch(
      requestAs("dan", "/.well-known/invite", {
        method: "POST",
        body: JSON.stringify({ id: "INV-DAN" }),
      }),
    );
    const presenceRes = await hub.peer.dispatch(
      requestAs("dan", "/.well-known/presence", {
        method: "POST",
        body: JSON.stringify({ seq: 1, addrs: ["/ip4/127.0.0.1/tcp/6000"] }),
      }),
    );
    const token = (await json(presenceRes)).token as string;

    const first = await hub.peer.dispatch(
      requestAs("dan", "/.well-known/mesh", { headers: bearer(token) }),
    );
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await hub.peer.dispatch(
      requestAs("dan", "/.well-known/mesh", {
        headers: { ...bearer(token), "if-none-match": etag! },
      }),
    );
    expect(second.status).toBe(304);
  });

  it("a peer that stops heartbeating leaves the view within one TTL", async () => {
    hub.invitations.create("INV-ERIN", ["member"], 60_000);
    await hub.peer.dispatch(
      requestAs("erin", "/.well-known/invite", {
        method: "POST",
        body: JSON.stringify({ id: "INV-ERIN" }),
      }),
    );
    const presenceRes = await hub.peer.dispatch(
      requestAs("erin", "/.well-known/presence", {
        method: "POST",
        body: JSON.stringify({ seq: 1, addrs: ["/ip4/127.0.0.1/tcp/7000"] }),
      }),
    );
    const token = (await json(presenceRes)).token as string;

    const before = await hub.peer.dispatch(
      requestAs("erin", "/.well-known/mesh", { headers: bearer(token) }),
    );
    expect((await json(before)).members[0].online).toBe(true);

    // Erin stops heartbeating. Advance the clock past the TTL and run the sweep directly.
    clock.now += PRESENCE_TTL_MS + 1;
    hub.sweep();

    const after = await hub.peer.dispatch(
      requestAs("erin", "/.well-known/mesh", { headers: bearer(token) }),
    );
    const member = (await json(after)).members.find((m: { peerId: string }) => m.peerId === "erin");
    expect(member.online).toBe(false);
    expect(member.addrs).toEqual([]);
  });

  it("an out-of-order presence write does not resurrect a departed peer", async () => {
    hub.invitations.create("INV-FRANK", ["member"], 60_000);
    await hub.peer.dispatch(
      requestAs("frank", "/.well-known/invite", {
        method: "POST",
        body: JSON.stringify({ id: "INV-FRANK" }),
      }),
    );
    const presenceRes = await hub.peer.dispatch(
      requestAs("frank", "/.well-known/presence", {
        method: "POST",
        body: JSON.stringify({ seq: 1, addrs: ["/ip4/127.0.0.1/tcp/8000"] }),
      }),
    );
    const token = (await json(presenceRes)).token as string;

    // Frank departs: the clock moves past the TTL and the sweep runs.
    clock.now += PRESENCE_TTL_MS + 1;
    hub.sweep();

    // A DELAYED duplicate of the original seq=1 heartbeat now arrives.
    const stale = await hub.peer.dispatch(
      requestAs("frank", "/.well-known/presence", {
        method: "POST",
        body: JSON.stringify({ seq: 1, addrs: ["/ip4/127.0.0.1/tcp/8000"] }),
      }),
    );
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toMatch(/stale-sequence/);

    const view = await hub.peer.dispatch(
      requestAs("frank", "/.well-known/mesh", { headers: bearer(token) }),
    );
    const member = (await json(view)).members.find((m: { peerId: string }) => m.peerId === "frank");
    expect(member.online).toBe(false);
  });

  it("a caller with no proven identity cannot reach a bootstrap path", async () => {
    const res = await hub.peer.dispatch(
      anonymousRequest("/.well-known/invite", {
        method: "POST",
        body: JSON.stringify({ id: "whatever" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
