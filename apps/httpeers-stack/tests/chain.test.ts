/**
 * R-2: chained peers, A -> B -> C. Note 30.
 *
 * PROMOTED (Task 7b) from
 * `notes/2026/2026-08/2026-08-16/httpeers-plan/prototypes/31-httpeers-prototype-v0.6.0-router-hardened/chain.test.ts`.
 * No assertion was altered — see `.superpowers/sdd/2026-08-18-httpeers-stack/task-7b-report.md`
 * for the full adaptation record. What changed here is construction only:
 * the archive's monolithic `createPeer({ isHub: true, ... })` became
 * `buildTestHub()` (this package's hub, `src/hub/endpoints.ts`, over a real
 * listening node) plus `buildTestPeer()` for everyone else — see
 * `tests/support/mesh.ts`.
 *
 * Written question: does the prefix strip/forward compose across real peers,
 * and does identity re-prove at each hop?
 *
 * WHAT THIS FOUND (in the archive): `createPeerRouter` applied the `access`
 * wrapper to the LOCAL branch only, so any peer could make any other peer
 * dial a third party and pump a stream on its behalf. It was invisible
 * because it fails CLOSED at the far end -- the third party rejects the
 * tokenless request, so every observable outcome looked correct. The damage
 * was the work done, not the answer returned. C5 is the test that pins it.
 *
 * Fixed by `allowForward` on the router (`httpeers.core`'s `router.ts`),
 * deny-by-default -- already in place before this task; C5 is what proves it
 * stays in place.
 */
import { multiaddr } from "@multiformats/multiaddr";
import { createPeer, type Peer } from "@statewalker/httpeers.core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHub, buildTestPeer, type TestHub, type TestPeer } from "./support/mesh.js";

let hub: TestHub, alice: TestPeer, bob: TestPeer, mallory: TestPeer;
let aliceToken: string, bobToken: string;

const dial = async (from: Peer, to: Peer) => from.libp2p.dial(multiaddr(to.addrs()[0]));

beforeAll(async () => {
  hub = await buildTestHub();
  alice = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });
  bob = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });
  mallory = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });

  for (const p of [alice, bob, mallory]) await dial(p, hub.peer);
  await dial(alice, bob); // A -> B
  await dial(bob, hub.peer); // B -> C (the hub plays C)
  await dial(mallory, bob);

  for (const [peer, code] of [
    [alice, "A"],
    [bob, "B"],
  ] as const) {
    hub.invitations.create(code, ["member"], 60_000);
    const res = await peer.call(hub.peer.peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id: code }),
    });
    const body = (await res.json()) as { token: string };
    if (peer === alice) aliceToken = body.token;
    else bobToken = body.token;
  }
}, 40_000);

afterAll(async () => {
  await Promise.all([hub?.stop(), alice?.stop(), bob?.stop(), mallory?.stop()]);
});

describe("R-2: chaining", () => {
  it("C1: A can reach C directly", async () => {
    const res = await alice.call(hub.peer.peerId, "/test/whoami", { token: aliceToken });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).you).toBe(alice.peerId);
  }, 20_000);

  it("C2: an explicitly-enabled relay DOES forward -- the prefix composes", async () => {
    const relay = await createPeer({
      hubPeerId: hub.peer.peerId,
      listen: ["/ip4/127.0.0.1/tcp/0"],
      allowRelay: true,
    });
    await relay.libp2p.dial(multiaddr(hub.peer.addrs()[0]));
    await alice.libp2p.dial(multiaddr(relay.addrs()[0]));
    const res = await alice.call(relay.peerId, `/${hub.peer.peerId}/test/whoami`, {
      token: aliceToken,
    });
    // Reached the hub and was refused by the binding, rather than 404ing at
    // the relay -- which is the whole point of this test, and any status
    // distinguishes "the hub answered" from "the relay never forwarded".
    //
    // 403 AGAIN (Task 34), after Task 29 moved it to 401. The binding is still
    // a check inside the token (`check if bound($k), connection_peer($k)`), so
    // the hub -- which proved the RELAY on this connection -- still cannot
    // verify Alice's token; what changed is that the refusal now carries its
    // reason instead of being flattened into "no token". 403 is the decision:
    // Alice refreshing her token does not make it presentable over the relay's
    // connection, so retrying cannot help.
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).reason).toBe("peer-binding");
    await relay.stop();
  }, 30_000);

  it("C3: even if relaying were allowed, the far end proves B and not A", async () => {
    // Kept as a statement about the binding: C sees Bob's connection while
    // Alice's token says sub=alice, so the far end would reject regardless.
    // Chaining fails closed at BOTH ends -- defence in depth.
    const relay = await createPeer({
      hubPeerId: hub.peer.peerId,
      listen: ["/ip4/127.0.0.1/tcp/0"],
      allowRelay: true,
    });
    await relay.libp2p.dial(multiaddr(hub.peer.addrs()[0]));
    await alice.libp2p.dial(multiaddr(relay.addrs()[0]));
    const res = await alice.call(relay.peerId, `/${hub.peer.peerId}/test/whoami`, {
      token: aliceToken,
    });
    // See C2. The refusal moved from `peer-handlers.ts`'s prose check to the
    // token's own Datalog binding at ADR-0019, so the far end refuses one step
    // earlier -- still fails closed, still for exactly the reason this test
    // names, and since Task 34 it SAYS so rather than answering the generic
    // "membership token required" every verification failure used to share.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "token subject does not match connected peer",
      reason: "peer-binding",
    });
    await relay.stop();
  }, 30_000);

  it("C4: B forwarding with ITS OWN token succeeds", async () => {
    // The proxy speaking for itself works. Identity is Bob's, not Alice's --
    // which is correct, and is also why a real reverse proxy cannot simply
    // forward a caller's token. Delegation (a token naming ACTOR and SUBJECT)
    // is undesigned; see note 30 section 6.
    const res = await bob.call(hub.peer.peerId, "/test/whoami", { token: bobToken });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).you).toBe(bob.peerId);
  }, 20_000);

  it("C5: a remote peer may NOT make us relay -- refused at B, not at C", async () => {
    // THE SECURITY TEST. Mallory is not a member and has no token. She must
    // not be able to make Bob dial the hub and pump a stream on her behalf.
    // Before the fix this returned 401 -- from the HUB, meaning Bob had
    // already done the work.
    const res = await mallory.call(bob.peerId, `/${hub.peer.peerId}/test/whoami`, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/relay/i);
  }, 20_000);

  it("C5b: a member may not relay either -- relaying is its own capability", async () => {
    const res = await alice.call(bob.peerId, `/${hub.peer.peerId}/test/whoami`, {
      token: aliceToken,
    });
    expect(res.status).toBe(403);
  }, 20_000);

  it("C6: a LOCAL request from Mallory is refused by Bob", async () => {
    // Contrast with C5: the local branch was always guarded.
    const res = await mallory.call(bob.peerId, "/test/whoami", {});
    expect(res.status).toBe(401);
  }, 20_000);

  it("C7: a chain through a non-relay terminates at the first hop", async () => {
    // NOTE: this does NOT prove cycles are impossible. Two relay-enabled
    // peers can still loop; there is no hop limit yet.
    const res = await alice.call(bob.peerId, `/${hub.peer.peerId}/${bob.peerId}/test/whoami`, {
      token: aliceToken,
    });
    expect(res.status).toBe(403);
  }, 20_000);
});
