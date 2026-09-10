/**
 * Unit coverage for `src/hub.ts`, written for the 2026-09-09 adoption (MESH-2).
 * NOT RECOVERED CODE — the export shipped no unit test for this file.
 *
 * §4 of the work order is explicit about why this exists: `tests/node-verify.mjs`
 * is INTEGRATION coverage, and `mesh.ts` and `hub.ts` are the two largest files
 * in the export with no unit test between them. The thirteen claims that harness
 * checks all run through two real libp2p peers and a relay, so each one proves a
 * whole path and none of them can isolate a branch.
 *
 * EVERY TEST BELOW IS DERIVED FROM A WRITTEN CLAIM, not from reading the code
 * (§5.1). The claim is quoted or cited in place, and its source is one of:
 *   - note 08, "Two Tabs, One Mesh" — the nine original claims and three findings
 *   - note 10, "Relay Discovery" — §4, what `JoinBlob` carries and why
 *   - `src/hub.ts`'s own module comment, which states four properties as rules
 * Where the record states a property the harness never exercises, it is tested
 * here; where it states one the harness already proves end to end, it is tested
 * here too but at the branch rather than the path, which is the point.
 *
 * ON THE RED STEP, stated rather than glossed: these tests could not be watched
 * failing against an absent `hub.ts`, because `hub.ts` had to land in the
 * previous commit to satisfy the adopted harness's thirteen claims (§0.2 cuts
 * the other way once a test already demands the file). The substitute is the
 * §5.3 mutation pass, which is run per claim and recorded in PROVENANCE.md — a
 * test that no mutation of the code can break is a test that was never red.
 */

import { describe, expect, it } from "vitest";
import {
  type Advertisement,
  decodeJoinBlob,
  encodeJoinBlob,
  guestHandler,
  type HubState,
  hubHandler,
  type JoinBlob,
  joinMesh,
  mintInvitation,
  newHubState,
} from "../src/hub.js";
import type { Peer } from "../src/mesh.js";

const ALICE = "12D3KooWAlice00000000000000000000000000000000000000";
const BOB = "12D3KooWBob0000000000000000000000000000000000000000";
const HUB_PEER = "12D3KooWHub0000000000000000000000000000000000000000";

const get = (path: string) => new Request(`http://hub${path}`);
const post = (path: string, body: unknown) =>
  new Request(`http://hub${path}`, { method: "POST", body: JSON.stringify(body) });

/** Admit `peerId` through the real invite route, so no test hand-edits state. */
async function admit(state: HubState, peerId: string): Promise<string> {
  const id = mintInvitation(state);
  const res = await hubHandler(state, "hub-tab")(
    post("/.well-known/invite", { invitationId: id }),
    peerId,
  );
  expect(res.status).toBe(200);
  return id;
}

// ---------------------------------------------------------------------------
// "MEMBERSHIP IS RECORDED AGAINST THE PROVEN PEER ID, never against anything
// in the request body. … a guest cannot claim to be another guest by writing a
// different id into its JSON." — hub.ts module comment; note 08 claim 5.
// ---------------------------------------------------------------------------

describe("membership is keyed on the proven peer id", () => {
  it("records the caller libp2p proved, not an id in the body", async () => {
    const state = newHubState();
    const id = mintInvitation(state);
    // The body names BOB. The transport proved ALICE. ALICE is the member.
    const res = await hubHandler(state, "hub-tab")(
      post("/.well-known/invite", {
        invitationId: id,
        member: BOB,
        callerPeerId: BOB,
        peerId: BOB,
      }),
      ALICE,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, member: ALICE });
    expect([...state.members]).toEqual([ALICE]);
    expect(state.members.has(BOB)).toBe(false);
  });

  it("an advertisement is filed under the proven caller, not a body field", async () => {
    const state = newHubState();
    await admit(state, ALICE);
    await hubHandler(state, "hub-tab")(
      post("/.well-known/advertise", {
        kind: "echo",
        path: "/echo",
        peerId: BOB,
        address: "/addr/alice",
      }),
      ALICE,
    );
    expect([...state.advertisements.keys()]).toEqual([ALICE]);
  });

  it("the greeting names the proven caller", async () => {
    // Weak on its own; here because it is the only route that echoes the
    // caller back, so it is where a swapped identity would be visible to a
    // human reading the page.
    const state = newHubState();
    await admit(state, ALICE);
    const res = await hubHandler(state, "hub-tab")(get("/hello"), ALICE);
    expect(await res.json()).toEqual({ from: "hub-tab", greeting: `hello, ${ALICE}` });
  });
});

// ---------------------------------------------------------------------------
// "INVITATIONS ARE SINGLE-USE, and the spent check runs first and
// unconditionally. A blob shared between two guests admits exactly one and
// fails the other with `already-redeemed`." — hub.ts module comment.
// "a redeemed id must fail the same way forever, whether or not it was ever
// valid." — the same comment, on the spent-first ordering.
// Note 08 claim 6: "a redeemed invitation cannot be reused".
// ---------------------------------------------------------------------------

describe("invitations are single-use", () => {
  it("a blob shared between two guests admits exactly one", async () => {
    // The claim stated at its full strength: not "the same peer twice" (which
    // is what the harness checks, since it only has one guest) but TWO DIFFERENT
    // peers racing one id. The harness cannot distinguish these, because a
    // second redemption by an existing member would also be refused by a
    // membership check rather than by the spent check.
    const state = newHubState();
    const handler = hubHandler(state, "hub-tab");
    const id = mintInvitation(state);

    const first = await handler(post("/.well-known/invite", { invitationId: id }), ALICE);
    const second = await handler(post("/.well-known/invite", { invitationId: id }), BOB);

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({ error: "already-redeemed" });
    expect([...state.members]).toEqual([ALICE]);
  });

  it("the spent check runs FIRST: a redeemed id stays already-redeemed, not unknown-invitation", async () => {
    // This is the ordering claim, and it is the reason `spentInvitations`
    // exists as a set of its own rather than being inferred from absence.
    // Delete-without-recording would make a spent id indistinguishable from
    // one that never existed, and the error a guest sees would change meaning.
    const state = newHubState();
    const handler = hubHandler(state, "hub-tab");
    const id = mintInvitation(state);
    await handler(post("/.well-known/invite", { invitationId: id }), ALICE);

    expect(state.openInvitations.has(id)).toBe(false);
    expect(state.spentInvitations.has(id)).toBe(true);

    const again = await handler(post("/.well-known/invite", { invitationId: id }), BOB);
    expect(await again.json()).toEqual({ error: "already-redeemed" });
  });

  it("an id that never existed is unknown-invitation, which is a different answer", async () => {
    // The other side of the pair. Without this, a mutation that answered
    // `already-redeemed` for everything would pass the test above.
    const state = newHubState();
    const res = await hubHandler(state, "hub-tab")(
      post("/.well-known/invite", { invitationId: "never-minted" }),
      ALICE,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "unknown-invitation" });
    expect(state.members.size).toBe(0);
  });

  it("a missing invitationId is unknown-invitation, not a crash", async () => {
    const state = newHubState();
    const res = await hubHandler(state, "hub-tab")(post("/.well-known/invite", {}), ALICE);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "unknown-invitation" });
  });

  it("each guest gets its own id — minting twice yields two open invitations", async () => {
    // "Mints an invitation. Each guest needs its own — see the module comment."
    const state = newHubState();
    const a = mintInvitation(state);
    const b = mintInvitation(state);
    expect(a).not.toBe(b);
    expect(state.openInvitations.size).toBe(2);
  });

  it("two guests with their own invitations both get in", async () => {
    const state = newHubState();
    const handler = hubHandler(state, "hub-tab");
    const idA = mintInvitation(state);
    const idB = mintInvitation(state);
    expect((await handler(post("/.well-known/invite", { invitationId: idA }), ALICE)).status).toBe(
      200,
    );
    expect((await handler(post("/.well-known/invite", { invitationId: idB }), BOB)).status).toBe(
      200,
    );
    expect([...state.members].sort()).toEqual([ALICE, BOB].sort());
  });
});

// ---------------------------------------------------------------------------
// Note 08 claim 3: "a peer that has not joined is refused (403)".
// The harness checks this on ONE route (`/hello`). The gate sits above every
// route except the invite one, so the claim is about the namespace.
// ---------------------------------------------------------------------------

describe("the membership gate", () => {
  const MEMBERS_ONLY = [
    ["GET", "/hello"],
    ["GET", "/.well-known/mesh"],
    ["POST", "/.well-known/advertise"],
    ["GET", "/anything-else"],
  ] as const;

  for (const [method, path] of MEMBERS_ONLY) {
    it(`refuses a non-member at ${method} ${path}`, async () => {
      const state = newHubState();
      const req = method === "POST" ? post(path, { kind: "echo", path: "/echo" }) : get(path);
      const res = await hubHandler(state, "hub-tab")(req, ALICE);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "not-a-member", caller: ALICE });
    });
  }

  it("the invite route is the ONE route open to a non-member", async () => {
    // The other side of the pair: a gate that refused everything would pass
    // every test above and make the hub unjoinable.
    const state = newHubState();
    const id = mintInvitation(state);
    const res = await hubHandler(state, "hub-tab")(
      post("/.well-known/invite", { invitationId: id }),
      ALICE,
    );
    expect(res.status).toBe(200);
  });

  it("a GET to the invite route is not a redemption — it falls through the gate", async () => {
    // The route is guarded on method as well as path. A non-member GETting it
    // must not redeem anything, and must be refused as a non-member.
    const state = newHubState();
    const id = mintInvitation(state);
    const res = await hubHandler(state, "hub-tab")(get("/.well-known/invite"), ALICE);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not-a-member", caller: ALICE });
    expect(state.openInvitations.has(id)).toBe(true);
  });

  it("a member is refused nothing, and an unknown path is 404 rather than 403", async () => {
    // Distinguishes "not allowed" from "not there" — a gate that returned 403
    // for unknown paths would hide every routing mistake behind an
    // authorization answer.
    const state = newHubState();
    await admit(state, ALICE);
    const res = await hubHandler(state, "hub-tab")(get("/nope"), ALICE);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not-found", path: "/nope" });
  });

  it("one member's membership does not admit another peer", async () => {
    const state = newHubState();
    await admit(state, ALICE);
    const res = await hubHandler(state, "hub-tab")(get("/hello"), BOB);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Note 08 claim 8: "the guest's advertisement is visible in the hub's mesh
// view". The mesh view is a fan-out over every member and every
// advertisement — the final-iteration shape §5.3 requires.
// ---------------------------------------------------------------------------

describe("the mesh view", () => {
  const AD: Advertisement = { address: "/addr/x", kind: "echo", path: "/echo" };

  it("lists every advertisement, the LAST one included", async () => {
    // FINAL-ITERATION PATH (§5.3). Three advertisers, and the assertion names
    // the third: a fan-out that dropped its last entry would pass a
    // one-advertiser test, and the harness has exactly one guest.
    const state = newHubState();
    const handler = hubHandler(state, "hub-tab");
    const peers = [ALICE, BOB, "12D3KooWCarol00000000000000000000000000000000000000"];
    for (const [i, peerId] of peers.entries()) {
      await admit(state, peerId);
      await handler(post("/.well-known/advertise", { ...AD, kind: `kind-${i}` }), peerId);
    }

    const view = (await (await handler(get("/.well-known/mesh"), ALICE)).json()) as {
      hub: string;
      members: string[];
      advertisements: (Advertisement & { peerId: string })[];
    };

    expect(view.hub).toBe("hub-tab");
    expect(view.members).toHaveLength(3);
    expect(view.advertisements).toHaveLength(3);
    expect(view.advertisements.map((a) => a.peerId)).toEqual(peers);
    expect(view.advertisements.map((a) => a.kind)).toEqual(["kind-0", "kind-1", "kind-2"]);
    // Named explicitly, so the failure says "the last one is missing".
    expect(view.advertisements.at(-1)).toMatchObject({ peerId: peers[2], kind: "kind-2" });
  });

  it("lists every member, the LAST one included", async () => {
    const state = newHubState();
    const peers = [ALICE, BOB, "12D3KooWCarol00000000000000000000000000000000000000"];
    for (const peerId of peers) await admit(state, peerId);
    const view = (await (
      await hubHandler(state, "hub-tab")(get("/.well-known/mesh"), ALICE)
    ).json()) as { members: string[] };
    expect(view.members).toEqual(peers);
    expect(view.members.at(-1)).toBe(peers[2]);
  });

  it("a member with no advertisement appears as a member and not as an advertiser", async () => {
    // The two collections are independent, and conflating them would make
    // "who is here" and "what is on offer" the same question.
    const state = newHubState();
    await admit(state, ALICE);
    await admit(state, BOB);
    await hubHandler(state, "hub-tab")(post("/.well-known/advertise", AD), ALICE);
    const view = (await (
      await hubHandler(state, "hub-tab")(get("/.well-known/mesh"), BOB)
    ).json()) as { members: string[]; advertisements: { peerId: string }[] };
    expect(view.members).toHaveLength(2);
    expect(view.advertisements.map((a) => a.peerId)).toEqual([ALICE]);
  });

  it("re-advertising replaces rather than appends", async () => {
    const state = newHubState();
    await admit(state, ALICE);
    const handler = hubHandler(state, "hub-tab");
    await handler(post("/.well-known/advertise", { ...AD, kind: "first" }), ALICE);
    await handler(post("/.well-known/advertise", { ...AD, kind: "second" }), ALICE);
    const view = (await (await handler(get("/.well-known/mesh"), ALICE)).json()) as {
      advertisements: { kind: string }[];
    };
    expect(view.advertisements).toHaveLength(1);
    expect(view.advertisements[0]?.kind).toBe("second");
  });

  it("the advertisement carries the advertiser's own address, which is what the caller dials", async () => {
    // The harness's claim 9 dials `ad.address` to reach the guest, so an
    // advertisement that lost its address would break the reverse direction —
    // the claim note 08 §3 calls the one that matters most.
    const state = newHubState();
    await admit(state, ALICE);
    const handler = hubHandler(state, "hub-tab");
    await handler(post("/.well-known/advertise", { ...AD, address: "/addr/alice/p2p/x" }), ALICE);
    const view = (await (await handler(get("/.well-known/mesh"), ALICE)).json()) as {
      advertisements: { address: string }[];
    };
    expect(view.advertisements[0]?.address).toBe("/addr/alice/p2p/x");
  });
});

// ---------------------------------------------------------------------------
// "The point of `/echo` is symmetry. A guest that only consumed would prove a
// client/server split the architecture explicitly does not have." — hub.ts.
// Note 08 claim 9 / §3: "resources flow both ways".
// SYMMETRIC PAIR (§5.3): the guest's side of the exchange, not only the hub's.
// ---------------------------------------------------------------------------

describe("the guest serves too", () => {
  it("echoes the message back, naming the proven caller", async () => {
    const res = await guestHandler("guest-tab")(post("/echo", { message: "both ways" }), HUB_PEER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: "guest-tab", echoed: "both ways", caller: HUB_PEER });
  });

  it("a message-less body echoes empty rather than undefined", async () => {
    const res = await guestHandler("guest-tab")(post("/echo", {}), HUB_PEER);
    expect(await res.json()).toEqual({ from: "guest-tab", echoed: "", caller: HUB_PEER });
  });

  it("GET /echo is not the echo route", async () => {
    // Method is part of the route here as it is on the hub's invite route.
    const res = await guestHandler("guest-tab")(get("/echo"), HUB_PEER);
    expect(res.status).toBe(404);
  });

  it("the guest gates nothing on membership — it has no members", async () => {
    // Deliberate asymmetry worth pinning: the guest answers any proven peer.
    // Whether that is right is a design question; that it is the current
    // behaviour should not be discoverable only by surprise.
    const res = await guestHandler("guest-tab")(
      post("/echo", { message: "hi" }),
      "12D3KooWStranger000000000000000000000000000000000",
    );
    expect(res.status).toBe(200);
  });

  it("an unknown path on the guest is 404 with the path named", async () => {
    const res = await guestHandler("guest-tab")(get("/not-here"), HUB_PEER);
    expect(await res.json()).toEqual({ error: "not-found", path: "/not-here" });
  });
});

// ---------------------------------------------------------------------------
// "base64url of JSON … it survives a copy-paste through a terminal, a chat
// window and an address bar without quoting … and it is one token, so nobody
// can paste half of it. It is not encryption." — hub.ts module comment.
// Note 10 §4: "`JoinBlob` now carries `relay` — the SOURCE, not a resolved
// multiaddr."
// ---------------------------------------------------------------------------

describe("the join blob", () => {
  const BLOB: JoinBlob = {
    relay: "https://relay.httpeers.net",
    hubAddress: `/ip4/1.2.3.4/tcp/443/ws/p2p/${HUB_PEER}/p2p-circuit/p2p/${HUB_PEER}`,
    invitationId: "abc-123_XYZ",
  };

  it("round-trips every field", () => {
    expect(decodeJoinBlob(encodeJoinBlob(BLOB))).toEqual(BLOB);
  });

  it("uses only the URL-safe alphabet and carries no padding", () => {
    // The stated property, asserted rather than assumed: `+`, `/` and `=`
    // are what would break a copy-paste through an address bar, and `=` is
    // also what a shell would want quoted.
    const encoded = encodeJoinBlob(BLOB);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });

  it("survives a round trip through a URL query parameter unchanged", () => {
    // "survives a copy-paste through … an address bar" made executable: the
    // blob must not need escaping, so what comes out of a URLSearchParams is
    // byte-identical to what went in.
    const encoded = encodeJoinBlob(BLOB);
    const url = new URL(`https://example.test/?join=${encoded}`);
    expect(url.searchParams.get("join")).toBe(encoded);
    expect(url.toString()).toContain(encoded);
    expect(decodeJoinBlob(url.searchParams.get("join") as string)).toEqual(BLOB);
  });

  it("is one token: it contains nothing that would let half of it look complete", () => {
    const encoded = encodeJoinBlob(BLOB);
    expect(encoded).not.toMatch(/[\s.,;&?#]/);
  });

  it("is not encryption — anyone holding it can read the invitation inside", () => {
    // Stated as a property on purpose, so nobody later treats the blob as a
    // secret-bearing token. A test that asserts the plaintext is visible is
    // the only way this stays true on purpose rather than by accident.
    const decoded = decodeJoinBlob(encodeJoinBlob(BLOB));
    expect(decoded.invitationId).toBe(BLOB.invitationId);
  });

  it("carries the relay SOURCE, so a redeployed relay is resolved afresh", () => {
    // Note 10 §4's reason, made checkable: a blob holding a RESOLVED multiaddr
    // would pin whatever the bootstrap document said when it was minted. The
    // URL must come back out as a URL.
    const decoded = decodeJoinBlob(encodeJoinBlob(BLOB));
    expect(decoded.relay).toBe("https://relay.httpeers.net");
    expect(decoded.relay.startsWith("/")).toBe(false);
  });

  it("carries a multiaddr relay unchanged too, for local development", () => {
    const local: JoinBlob = { ...BLOB, relay: "/ip4/127.0.0.1/tcp/9590/ws/p2p/12D3KooWLocal" };
    expect(decodeJoinBlob(encodeJoinBlob(local)).relay).toBe(local.relay);
  });

  it("round-trips non-ASCII, because base64 is over bytes and JSON is UTF-8", () => {
    const idn: JoinBlob = { ...BLOB, relay: "https://relais-café.example" };
    expect(decodeJoinBlob(encodeJoinBlob(idn))).toEqual(idn);
  });
});

// ---------------------------------------------------------------------------
// `joinMesh` — redeem, then advertise. Note 08 claims 4 and 8 together.
// Driven through a fake `Peer`, which is the seam `mesh.ts` exposes.
// ---------------------------------------------------------------------------

function fakePeer(
  reply: (request: Request) => Response | Promise<Response>,
): Peer & { calls: { address: string; path: string; body: string }[] } {
  const calls: { address: string; path: string; body: string }[] = [];
  return {
    calls,
    node: {} as Peer["node"],
    peerId: ALICE,
    address: "/addr/alice/p2p/alice",
    relayAddrs: ["/addr/relay"],
    async fetch(address, request) {
      calls.push({
        address,
        path: new URL(request.url).pathname,
        body: await request.clone().text(),
      });
      return reply(request);
    },
    async stop() {},
  };
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("joinMesh", () => {
  it("redeems, then advertises, in that order and both at the hub's address", async () => {
    const peer = fakePeer((request) =>
      new URL(request.url).pathname === "/.well-known/invite"
        ? ok({ ok: true, hub: "hub-tab" })
        : ok({ ok: true }),
    );
    const blob: JoinBlob = {
      relay: "https://r.test",
      hubAddress: "/addr/hub/p2p/hub",
      invitationId: "inv-1",
    };

    const result = await joinMesh(peer, blob, { kind: "echo", path: "/echo" });

    expect(result).toEqual({ hub: "hub-tab" });
    expect(peer.calls.map((c) => c.path)).toEqual([
      "/.well-known/invite",
      "/.well-known/advertise",
    ]);
    expect(peer.calls.every((c) => c.address === blob.hubAddress)).toBe(true);
  });

  it("sends the invitation id and this peer's own address when redeeming", async () => {
    const peer = fakePeer(() => ok({ ok: true, hub: "hub-tab" }));
    await joinMesh(
      peer,
      { relay: "https://r.test", hubAddress: "/addr/hub", invitationId: "inv-9" },
      {
        kind: "echo",
        path: "/echo",
      },
    );
    expect(JSON.parse(peer.calls[0]?.body ?? "{}")).toEqual({
      invitationId: "inv-9",
      address: "/addr/alice/p2p/alice",
    });
  });

  it("stamps the advertisement with this peer's own address, not one the caller supplied", async () => {
    // SYMMETRIC PAIR with the redeem call above: both messages carry
    // `peer.address`, and the mesh view's dialability depends on this one.
    const peer = fakePeer(() => ok({ ok: true, hub: "hub-tab" }));
    await joinMesh(
      peer,
      { relay: "https://r.test", hubAddress: "/addr/hub", invitationId: "i" },
      {
        kind: "echo",
        path: "/echo",
      },
    );
    expect(JSON.parse(peer.calls[1]?.body ?? "{}")).toEqual({
      kind: "echo",
      path: "/echo",
      address: "/addr/alice/p2p/alice",
    });
  });

  it("throws the hub's own error when the join is refused, and does NOT advertise", async () => {
    // The harness asserts the `already-redeemed` message reaches the caller.
    // What it cannot see is that the advertise call is skipped — a join that
    // advertised anyway would put a non-member in the mesh view.
    const peer = fakePeer(() => ok({ error: "already-redeemed" }, 403));
    await expect(
      joinMesh(
        peer,
        { relay: "https://r.test", hubAddress: "/addr/hub", invitationId: "spent" },
        {
          kind: "echo",
          path: "/echo",
        },
      ),
    ).rejects.toThrow(/already-redeemed/);
    expect(peer.calls.map((c) => c.path)).toEqual(["/.well-known/invite"]);
  });

  it("a 200 that is not ok:true is still a refusal", async () => {
    // Both halves of the condition, because either alone would let a
    // half-answer through.
    const peer = fakePeer(() => ok({ hub: "hub-tab" }));
    await expect(
      joinMesh(
        peer,
        { relay: "https://r.test", hubAddress: "/addr/hub", invitationId: "i" },
        {
          kind: "echo",
          path: "/echo",
        },
      ),
    ).rejects.toThrow(/join refused/);
  });

  it("an ok:true on a non-200 is still a refusal", async () => {
    const peer = fakePeer(() => ok({ ok: true, hub: "hub-tab" }, 403));
    await expect(
      joinMesh(
        peer,
        { relay: "https://r.test", hubAddress: "/addr/hub", invitationId: "i" },
        {
          kind: "echo",
          path: "/echo",
        },
      ),
    ).rejects.toThrow(/join refused/);
  });

  it('falls back to the name "hub" when the hub sends none', async () => {
    const peer = fakePeer(() => ok({ ok: true }));
    const result = await joinMesh(
      peer,
      { relay: "https://r.test", hubAddress: "/a", invitationId: "i" },
      {
        kind: "echo",
        path: "/echo",
      },
    );
    expect(result).toEqual({ hub: "hub" });
  });
});

// ---------------------------------------------------------------------------
// The whole cycle against the real handlers, with no transport at all. This is
// `node-verify.mjs`'s thirteen claims minus libp2p — so a failure here is the
// logic, and a failure there with this green is the network.
// ---------------------------------------------------------------------------

describe("the full cycle, transport removed", () => {
  it("refuse, join, consume, advertise, and the hub calls back", async () => {
    const state = newHubState();
    const hub = hubHandler(state, "hub-tab");
    const guest = guestHandler("guest-tab");

    expect((await hub(get("/hello"), ALICE)).status).toBe(403);

    const id = mintInvitation(state);
    expect((await hub(post("/.well-known/invite", { invitationId: id }), ALICE)).status).toBe(200);

    const hello = (await (await hub(get("/hello"), ALICE)).json()) as { from: string };
    expect(hello.from).toBe("hub-tab");

    await hub(
      post("/.well-known/advertise", { kind: "echo", path: "/echo", address: "/addr/alice" }),
      ALICE,
    );
    const view = (await (await hub(get("/.well-known/mesh"), ALICE)).json()) as {
      advertisements: { peerId: string; kind: string; path: string; address: string }[];
    };
    const ad = view.advertisements.find((a) => a.peerId === ALICE);
    expect(ad).toMatchObject({ kind: "echo", address: "/addr/alice" });

    // The reverse direction: the hub is the caller now.
    const echoed = (await (
      await guest(
        new Request(`http://guest${ad?.path}`, {
          method: "POST",
          body: JSON.stringify({ message: "both ways" }),
        }),
        HUB_PEER,
      )
    ).json()) as { echoed: string; caller: string };
    expect(echoed).toEqual({ echoed: "both ways", caller: HUB_PEER, from: "guest-tab" });
  });
});
