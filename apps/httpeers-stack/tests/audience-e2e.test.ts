/**
 * A-24 end to end: the DESTINATION enforces a token's audience (ADR-0020),
 * over real libp2p.
 *
 * WHAT THIS ADDS OVER `packages/httpeers.core/tests/tokens.test.ts`. That
 * suite proves the mechanism against real signed bytes, but it stands in for
 * the destination by passing `selfPeer` to `verifyToken` by hand. Here there
 * is no standing in: two real provider peers listen on loopback TCP, Alice
 * dials each of them directly, and each provider's own `createPeer` asserts
 * its own `self_peer` fact out of its own identity. The peer that refuses is
 * the peer the request was addressed to.
 *
 * WHY DIRECT DIALS AND NO RELAY. The failure ADR-0020 defends against is a
 * router or a forwarding peer not respecting a restriction it was trusted to
 * respect. A test that proved refusal only on a forwarded path would be
 * proving something about the router. Every request below is dialled STRAIGHT
 * AT the provider over a Noise-authenticated connection — the most favourable
 * possible arrival for the token — and it is still refused. The refusal is
 * therefore a property of the destination, not an artefact of the route.
 *
 * THE CONTROL IS NOT OPTIONAL. `providerB` refusing a scoped token proves
 * nothing on its own: a provider that refused every token from this hub would
 * look identical. So the same Alice, over the same connection, at the same
 * provider, with an UNRESTRICTED token from the same hub, is admitted. The
 * only difference between the two requests is what the token says about its
 * audience.
 */
import { multiaddr } from "@multiformats/multiaddr";
import { createMounts, verifyToken } from "@statewalker/httpeers.core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestSurfaceHandler } from "../src/hub/endpoints.js";
import { buildTestHub, buildTestPeer, type TestHub, type TestPeer } from "./support/mesh.js";

let hub: TestHub;
let alice: TestPeer;
let providerA: TestPeer;
let providerB: TestPeer;

/** Alice's token, minted by the hub for providerA and nobody else. */
let scopedToA: string;
/** The same token in every respect except that it names no audience. */
let unrestricted: string;

const provider = (): Parameters<typeof buildTestPeer>[0] => ({
  hubPeerId: hub.peer.peerId,
  listen: ["/ip4/127.0.0.1/tcp/0"],
  mounts: (ctx) => {
    const mounts = createMounts();
    mounts.provide("/test", createTestSurfaceHandler(ctx.peerId));
    return mounts;
  },
});

beforeAll(async () => {
  hub = await buildTestHub();
  alice = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });
  providerA = await buildTestPeer(provider());
  providerB = await buildTestPeer(provider());

  for (const p of [alice, providerA, providerB]) {
    await p.libp2p.dial(multiaddr(hub.peer.addrs()[0]!));
  }
  await alice.libp2p.dial(multiaddr(providerA.addrs()[0]!));
  await alice.libp2p.dial(multiaddr(providerB.addrs()[0]!));

  // The hub mints, through the same closure its own endpoints use. `member`
  // is what `DEFAULT_RULES` derives `std:test` from, which is what gates the
  // `/test` surface both providers mount.
  scopedToA = await hub.mintToken(alice.peerId, ["member"], { audience: [providerA.peerId] });
  unrestricted = await hub.mintToken(alice.peerId, ["member"]);
}, 40_000);

afterAll(async () => {
  await Promise.all([hub?.stop(), alice?.stop(), providerA?.stop(), providerB?.stop()]);
});

describe("A-24 end to end: a token names its audience", () => {
  it("least privilege is expressible: the hub mints a token for ONE named peer", async () => {
    const claims = await verifyToken(scopedToA, {
      issuer: hub.peer.peerId,
      connectionPeer: alice.peerId,
      selfPeer: providerA.peerId,
    });
    expect(claims.audience).toEqual([providerA.peerId]);
    expect(claims.sub).toBe(alice.peerId);
  }, 20_000);

  it("it works at the peer it names", async () => {
    const res = await alice.call(providerA.peerId, "/test/whoami", { token: scopedToA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { you: string; servedBy: string };
    expect(body.you).toBe(alice.peerId);
    expect(body.servedBy).toBe(providerA.peerId);
  }, 20_000);

  it("AND THE OTHER PROVIDER REFUSES IT -- dialled straight at it, nothing forwarded", async () => {
    const res = await alice.call(providerB.peerId, "/test/whoami", { token: scopedToA });

    // 403 AND THE REASON, both of which arrived with Task 34. Task 31 left
    // this as 401 "membership token required" and recorded the gap: the
    // audience check lives INSIDE the token, so the token does not verify at
    // providerB at all, and `peer.ts`'s `getClaims` swallowed every
    // verification failure into `null` -- so `reason: "audience"` was
    // observable only one layer down, in `httpeers.core`'s `tokens.test.ts`.
    // The seam is now a discriminated result and the reason travels all the
    // way to the body.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "this peer is not an intended audience for this token",
      reason: "audience",
    });
  }, 20_000);

  it("THE RETRY LOOP IS GONE: refreshing the token changes nothing, and the status says so", async () => {
    // The defect Task 34 exists for, stated as the client's own experience.
    //
    // Under the old collapse this refusal was 401 "membership token required"
    // -- the same answer a client gets for presenting NO token, whose remedy
    // is to go and get one. So a client scoped to providerA and calling
    // providerB would refresh, present a token scoped exactly the same way,
    // and be refused identically. Forever, with nothing in the exchange able
    // to say that refreshing was not the remedy.
    //
    // The refresh here is a real one: a second, genuinely different token from
    // the same hub through the same closure its endpoints mint with.
    const first = await alice.call(providerB.peerId, "/test/whoami", { token: scopedToA });
    expect(first.status).toBe(403);

    const refreshed = await hub.mintToken(alice.peerId, ["member"], {
      audience: [providerA.peerId],
    });
    expect(refreshed).not.toBe(scopedToA); // genuinely fresh bytes, not the same token back

    const second = await alice.call(providerB.peerId, "/test/whoami", { token: refreshed });

    // (i) Refreshing did not help -- the refusal is byte-identical.
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({
      error: "this peer is not an intended audience for this token",
      reason: "audience",
    });

    // (ii) And the client was TOLD not to retry. 403 is the whole signal: 401
    // means "authenticate and try again", which is the advice that produced
    // the loop. The counterfactual matters as much as the assertion -- a
    // handler that answered 403 to everything would pass (i) too.
    const tokenless = await alice.call(providerB.peerId, "/test/whoami");
    expect(tokenless.status).toBe(401);
    expect(((await tokenless.json()) as { error: string }).error).toBe("membership token required");

    // (iii) And the refreshed token is not simply broken: it works where it
    // is meant to, so (i) is about the destination and not about the mint.
    const atA = await alice.call(providerA.peerId, "/test/whoami", { token: refreshed });
    expect(atA.status).toBe(200);
  }, 30_000);

  it("... AND THE CONTROL: an unrestricted token from the same hub IS admitted there", async () => {
    // Same Alice, same connection, same provider, same hub, same roles. Only
    // the audience differs. Without this the test above would also pass if
    // providerB simply refused everything.
    const res = await alice.call(providerB.peerId, "/test/whoami", { token: unrestricted });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { servedBy: string }).servedBy).toBe(providerB.peerId);
  }, 20_000);

  it("the scoped token is not merely a broken token: it still works at providerA afterwards", async () => {
    // Guards against the refusal above being some one-shot state change
    // (a consumed nonce, a poisoned cache) rather than a per-destination
    // decision. The same bytes, refused at B, are still good at A.
    const res = await alice.call(providerA.peerId, "/test/whoami", { token: scopedToA });
    expect(res.status).toBe(200);
  }, 20_000);

  it("the hub's own invitation tokens stay explicitly unrestricted", async () => {
    // The migration statement, at the deployment level: nothing about the
    // join protocol changed, and the token it hands out says so in as many
    // words rather than by saying nothing (ADR-0020's "an unrestricted token
    // is a distinct, explicit state").
    hub.invitations.create("AUD-CODE", ["member"], 60_000);
    const res = await alice.call(hub.peer.peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id: "AUD-CODE" }),
    });
    expect(res.status).toBe(200);
    const token = ((await res.json()) as { token: string }).token;

    const claims = await verifyToken(token, {
      issuer: hub.peer.peerId,
      connectionPeer: alice.peerId,
      selfPeer: providerB.peerId,
    });
    expect(claims.audience).toBe("unrestricted");
  }, 20_000);
});
