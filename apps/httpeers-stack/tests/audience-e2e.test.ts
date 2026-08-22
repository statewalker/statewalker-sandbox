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

    // 401, not 403, and for the same reason a wrong-subject token is 401
    // since ADR-0019: the audience check lives INSIDE the token, so the token
    // does not verify at providerB at all. `getClaims` reports no claims and
    // the binding middleware answers before any policy runs. The refusal is
    // the property; the status is the shape every token-verification failure
    // already has here.
    //
    // What the refusal REPORTS is finer-grained one layer down and is
    // asserted where it is observable (`httpeers.core`'s `tokens.test.ts`):
    // `TokenVerificationError` carries `reason: "audience"` and the failing
    // rule text `block 0 check 2: check if audience($k), self_peer($k)`.
    // `peer.ts`'s `getClaims` swallows every verification failure into
    // `null`, so none of that reaches this response body. That is a gap this
    // task did not close -- see the task report.
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/membership token required/);
  }, 20_000);

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
