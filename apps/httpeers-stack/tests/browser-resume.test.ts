/**
 * Task 28's central claim, pinned against a REAL hub: a page that has
 * already joined can get back in WITHOUT an invitation, and a page that
 * tries to redeem the same invitation twice cannot.
 *
 * WHY THIS SUITE HAD TO BE WRITTEN BEFORE TRUSTING THE DESIGN. Resuming
 * rests on three facts about code this task does not own -- that `POST
 * /.well-known/presence` is a bootstrap route and therefore needs no token
 * (`usesTransportIdentity`), that its handler answers 403 for a
 * non-member and a freshly minted token for a member, and that the hub
 * refuses a presence write whose `seq` is not above the highest it has ever
 * accepted for that peer (`lastSeqByPeer`, which the TTL sweep does not
 * clear). Each is asserted below against `createHubEndpoints` itself, over
 * real libp2p nodes, rather than taken from a reading of the source.
 *
 * TWO NODES, ONE KEY, IS HOW A "RELOAD" IS SPELT HERE. A page reload is a
 * new libp2p node built from the same persisted identity, so that is
 * literally what these tests do: stop the peer, build another from the same
 * `privateKey`, and watch what the hub says. Nothing about the browser is
 * simulated -- what differs in a real page is the transport (WebRTC over a
 * relay rather than loopback TCP) and the ServiceWorker edge, neither of
 * which participates in any of this.
 *
 * WHAT IS NOT HERE AND NEEDS A BROWSER: `startBrowserPeer` end to end (a
 * relay, WebRTC and a ServiceWorker registration) and IndexedDB. The
 * resume/redeem DECISION `startBrowserPeer` makes is covered without either
 * in `tests/browser-session.test.ts`; the storage is covered over an
 * injected backend in `tests/browser-identity.test.ts`.
 */
import { multiaddr } from "@multiformats/multiaddr";
import type { Ed25519PrivateKey, PeerIdStr } from "@statewalker/httpeers.core";
import { generateMeshKey } from "@statewalker/httpeers.core";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPresenceRefusal,
  nextInitialSeq,
  redeemInvitation,
  resumeMembership,
  startJoin,
} from "../src/browser/join.js";
import { buildTestHub, buildTestPeer, type TestHub, type TestPeer } from "./support/mesh.js";

let hub: TestHub | undefined;
const peers: TestPeer[] = [];
let stopJoin: (() => void) | undefined;

/** A peer over loopback TCP, dialled to the hub and ready to call it. `privateKey` makes it "the same page, reloaded". */
async function connectedPeer(privateKey?: Ed25519PrivateKey): Promise<TestPeer> {
  const peer = await buildTestPeer({ hubPeerId: hub?.peer.peerId, privateKey });
  peers.push(peer);
  await peer.libp2p.dial(multiaddr(hub!.peer.addrs()[0]!));
  return peer;
}

/** The body a resume probe sends, minus the parts each test varies. */
const probe = (peer: TestPeer, hubPeerId: PeerIdStr, seq: number) =>
  resumeMembership({ peer, hubPeerId, addrs: peer.addrs(), seq });

afterEach(async () => {
  stopJoin?.();
  stopJoin = undefined;
  await Promise.all(peers.splice(0).map((p) => p.stop()));
  await hub?.stop();
  hub = undefined;
});

describe("resuming a membership instead of redeeming an invitation", () => {
  it("the second run of a page cannot redeem its invitation again -- which is why resume exists", async () => {
    hub = await buildTestHub();
    const key = await generateMeshKey();

    hub.invitations.create("invite-once", ["member"], 60_000);
    const first = await connectedPeer(key);
    await redeemInvitation(first, hub.peer.peerId, "invite-once");
    await first.stop();

    // The reload: same identity, a brand-new node.
    const second = await connectedPeer(key);
    await expect(redeemInvitation(second, hub.peer.peerId, "invite-once")).rejects.toThrow(
      /already-redeemed/,
    );
  }, 30_000);

  it("that same second run resumes with no invitation, and is handed a fresh token", async () => {
    hub = await buildTestHub();
    const key = await generateMeshKey();

    hub.invitations.create("invite-resume", ["member"], 60_000);
    const first = await connectedPeer(key);
    await redeemInvitation(first, hub.peer.peerId, "invite-resume");
    await first.stop();

    const second = await connectedPeer(key);
    const outcome = await probe(second, hub.peer.peerId, nextInitialSeq());

    expect(outcome.status).toBe("resumed");
    if (outcome.status !== "resumed") return;
    expect(typeof outcome.token).toBe("string");
    expect(outcome.token.length).toBeGreaterThan(0);
    // The probe IS the first heartbeat: this peer is already present.
    expect(hub.memberStore.get(second.peerId)?.roles).toEqual(["member"]);
  }, 30_000);

  it("a peer the hub has never seen is refused `not-a-member`, not let in", async () => {
    hub = await buildTestHub();
    const stranger = await connectedPeer();

    const outcome = await probe(stranger, hub.peer.peerId, nextInitialSeq());

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.refusal.kind).toBe("not-a-member");
    expect(outcome.refusal.status).toBe(403);
  }, 30_000);

  it("a membership revoked while the page was away is `not-a-member` too -- the same answer, so the same prompt", async () => {
    hub = await buildTestHub();
    const key = await generateMeshKey();

    hub.invitations.create("invite-revoked", ["member"], 60_000);
    const first = await connectedPeer(key);
    await redeemInvitation(first, hub.peer.peerId, "invite-revoked");
    await first.stop();

    // What `DELETE /admin/members/{peerId}` does (`src/hub/admin.ts`).
    hub.memberStore.remove(first.peerId);
    hub.revocations.revoke(first.peerId);

    const second = await connectedPeer(key);
    const outcome = await probe(second, hub.peer.peerId, nextInitialSeq());

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.refusal.kind).toBe("not-a-member");
  }, 30_000);
});

describe("the duplicate-identity diagnosis", () => {
  it("a heartbeat below one the hub has already accepted is refused 409 and reads as a second live node", async () => {
    hub = await buildTestHub();
    const key = await generateMeshKey();

    hub.invitations.create("invite-dup", ["member"], 60_000);
    const peer = await connectedPeer(key);
    await redeemInvitation(peer, hub.peer.peerId, "invite-dup");

    const seq = nextInitialSeq();
    expect((await probe(peer, hub.peer.peerId, seq)).status).toBe("resumed");

    // A SECOND node under this identity is, from the hub's side, exactly
    // "another write arrives whose seq is not above the highest accepted".
    // Reproduced here by writing below that mark rather than by starting a
    // second libp2p node on the same key, which would be the same request
    // with a slower test.
    const outcome = await probe(peer, hub.peer.peerId, seq - 1);

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.refusal.kind).toBe("duplicate-identity");
    expect(outcome.refusal.status).toBe(409);
  }, 30_000);

  it("startJoin continues above the probe's seq -- a resumed page's very first heartbeat is accepted", async () => {
    hub = await buildTestHub();
    const key = await generateMeshKey();

    hub.invitations.create("invite-seq", ["member"], 60_000);
    const peer = await connectedPeer(key);
    await redeemInvitation(peer, hub.peer.peerId, "invite-seq");

    const seq = nextInitialSeq();
    const resumed = await probe(peer, hub.peer.peerId, seq);
    expect(resumed.status).toBe("resumed");
    if (resumed.status !== "resumed") return;

    const beats: number[] = [];
    const refusals: string[] = [];
    const join = startJoin({
      peer,
      node: peer.libp2p,
      hubPeerId: hub.peer.peerId,
      relayAddr: "/ip4/127.0.0.1/tcp/1",
      initialToken: resumed.token,
      initialSeq: seq,
      revocationCache: peer.revocations,
      heartbeatIntervalMs: 60_000, // only the immediate first beat matters here
      keepaliveIntervalMs: 60_000,
      onHeartbeat: (versions) => beats.push(versions.mesh),
      onPresenceRefused: (refusal) => refusals.push(refusal.kind),
    });
    stopJoin = join.stop;

    await expect.poll(() => beats.length, { timeout: 10_000 }).toBeGreaterThan(0);
    // The point of `initialSeq`: without it this beat would have restarted
    // the count and been refused as stale for as long as it took to climb
    // back past `seq`.
    expect(refusals).toEqual([]);
  }, 30_000);

  it("a refusal that arrives while the page is live is reported rather than swallowed", async () => {
    hub = await buildTestHub();
    const key = await generateMeshKey();

    hub.invitations.create("invite-lost", ["member"], 60_000);
    const peer = await connectedPeer(key);
    const redemption = await redeemInvitation(peer, hub.peer.peerId, "invite-lost");

    const refusals: string[] = [];
    const join = startJoin({
      peer,
      node: peer.libp2p,
      hubPeerId: hub.peer.peerId,
      relayAddr: "/ip4/127.0.0.1/tcp/1",
      initialToken: redemption.token,
      revocationCache: peer.revocations,
      heartbeatIntervalMs: 250,
      keepaliveIntervalMs: 60_000,
      onPresenceRefused: (refusal) => refusals.push(refusal.kind),
    });
    stopJoin = join.stop;

    // The membership goes away underneath a live, heartbeating page.
    hub.memberStore.remove(peer.peerId);

    await expect.poll(() => refusals, { timeout: 10_000 }).toContain("not-a-member");
  }, 30_000);
});

describe("classifyPresenceRefusal", () => {
  it("maps the three answers a hub can give, and carries the body through for the rest", () => {
    expect(classifyPresenceRefusal(403, '{"error":"not a member"}').kind).toBe("not-a-member");
    expect(classifyPresenceRefusal(409, '{"error":"stale-sequence"}').kind).toBe(
      "duplicate-identity",
    );

    const other = classifyPresenceRefusal(500, "the hub fell over");
    expect(other.kind).toBe("refused");
    expect(other.message).toBe("the hub fell over");
    // An empty body still leaves something legible to render.
    expect(classifyPresenceRefusal(502, "").message).toBe("HTTP 502");
  });
});

describe("nextInitialSeq", () => {
  it("is above any number a previous run of the same page could have reached", () => {
    // A run advances its own counter by 1 per heartbeat while the clock
    // advances by `HEARTBEAT_INTERVAL_MS` -- so a later run always starts
    // above an earlier one's last beat. Pinned as an inequality against the
    // clock rather than as an implementation detail.
    const before = Date.now();
    const seq = nextInitialSeq();
    expect(seq).toBeGreaterThanOrEqual(before);
    expect(seq).toBeLessThanOrEqual(Date.now());
  });
});
