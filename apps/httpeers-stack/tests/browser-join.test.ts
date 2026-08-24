/**
 * `src/browser/join.ts`'s network-facing logic (`redeemInvitation`,
 * `startJoin`, `preDialPeer`'s multiaddr construction) touches no browser
 * API at all -- it imports only `@libp2p/interface`, `@libp2p/peer-id`,
 * `@multiformats/multiaddr`, and `@statewalker/httpeers.core`. It is
 * exercised here over real libp2p nodes and a real hub, via
 * `tests/support/mesh.ts`'s `buildTestHub`/`buildTestPeer` -- the same
 * harness `chain.test.ts`/`integration.test.ts`/`revocation-e2e.test.ts`
 * already use. Reviewed correction to this task's original report, which
 * claimed the whole `src/browser/` surface needed a browser: only
 * `node-profile.ts`'s actual transport construction, real reservation
 * timing, and the ServiceWorker edge genuinely do (Task 15).
 *
 * The property that matters most, and the one a merely-observes-A-refetch
 * test would not distinguish from a wholesale-refetch implementation:
 * EACH version counter gates ONLY its own section. Proven below by
 * bumping the hub's mesh version alone (a second invitation redeemed,
 * which adds a member with no policy or vocabulary change) and asserting
 * the rules/revocations endpoints are NOT called again on the
 * heartbeat that picks it up.
 */
import { multiaddr } from "@multiformats/multiaddr";
import type { Peer, PeerIdStr } from "@statewalker/httpeers.core";
import { RevocationCache } from "@statewalker/httpeers.core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preDialPeer, redeemInvitation, startJoin } from "../src/browser/join.js";
import { buildTestHub, buildTestPeer, type TestHub, type TestPeer } from "./support/mesh.js";

/** Wraps `peer.call` to record every path called, delegating to the real implementation -- lets a test observe exactly which `.well-known` endpoints a heartbeat actually touched, without instrumenting the hub itself. */
function recordingPeer(peer: Peer): { peer: Peer; calls: string[] } {
  const calls: string[] = [];
  const wrapped: Peer = {
    ...peer,
    call: async (targetPeerId, path, init) => {
      calls.push(path);
      return peer.call(targetPeerId, path, init);
    },
  };
  return { peer: wrapped, calls };
}

/** Resolves the next time `onHeartbeat` fires -- event-driven synchronization instead of a fixed sleep, so the test is not racing a wall-clock guess against real (if loopback-fast) network round trips. */
function nextHeartbeat(): { promise: Promise<void>; onHeartbeat: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, onHeartbeat: () => resolve() };
}

let hub: TestHub | undefined;
let clientPeer: TestPeer | undefined;
let stopJoin: (() => void) | undefined;

afterEach(async () => {
  stopJoin?.();
  stopJoin = undefined;
  await Promise.all([clientPeer?.stop(), hub?.stop()]);
  clientPeer = undefined;
  hub = undefined;
});

describe("join.ts against a real hub and a real TCP peer", () => {
  it("redeemInvitation mints a token carrying the invitation's roles", async () => {
    hub = await buildTestHub();
    clientPeer = await buildTestPeer({ hubPeerId: hub.peer.peerId });
    await clientPeer.libp2p.dial(multiaddr(hub.peer.addrs()[0]!));

    hub.invitations.create("invite-redeem", ["member"], 60_000);
    const redemption = await redeemInvitation(clientPeer, hub.peer.peerId, "invite-redeem");

    expect(redemption.roles).toEqual(["member"]);
    expect(redemption.mesh).toBe(hub.peer.peerId);
    expect(typeof redemption.token).toBe("string");
  }, 20_000);

  it("startJoin's heartbeat gates each section on its own version counter -- a mesh-only change does not refetch the rules or the revocations", async () => {
    hub = await buildTestHub();
    clientPeer = await buildTestPeer({ hubPeerId: hub.peer.peerId });
    await clientPeer.libp2p.dial(multiaddr(hub.peer.addrs()[0]!));

    hub.invitations.create("invite-join", ["member"], 60_000);
    const redemption = await redeemInvitation(clientPeer, hub.peer.peerId, "invite-join");

    const { peer: recorded, calls } = recordingPeer(clientPeer);
    const revocationCache = new RevocationCache({ maxStalenessMs: 60_000 });
    const first = nextHeartbeat();
    // Counts COMPLETED heartbeats: `startJoin` calls `onHeartbeat` as the last
    // statement of `heartbeatOnce`, after every conditional refetch it was
    // going to make has already run. See the wait below.
    let heartbeats = 0;

    const join = startJoin({
      peer: recorded,
      node: clientPeer.libp2p,
      hubPeerId: hub.peer.peerId,
      relayAddr: hub.peer.addrs()[0]!, // unused by the heartbeat itself; only the keepalive timer would read it, and it never fires in this test's window.
      initialToken: redemption.token,
      revocationCache,
      heartbeatIntervalMs: 50,
      keepaliveIntervalMs: 60_000,
      onHeartbeat: () => {
        heartbeats += 1;
        first.onHeartbeat();
      },
    });
    stopJoin = join.stop;

    // First heartbeat: every watermark starts at 0, and the hub's real
    // counters all start at 1 -- so everything refetches once, by
    // construction. This is not yet evidence of SELECTIVE behaviour; it
    // only establishes the baseline the second heartbeat is measured
    // against.
    await first.promise;
    expect(calls).toEqual(
      expect.arrayContaining([
        "/.well-known/presence",
        "/.well-known/mesh",
        "/.well-known/rules",
        "/.well-known/revocations",
      ]),
    );
    expect(join.meshView()).not.toBeNull();
    expect(join.rules()).not.toBeNull();
    calls.length = 0; // reset the log -- everything from here on is attributable to the second heartbeat alone.

    // Bump ONLY the hub's mesh version: a second member redeeming an
    // invitation adds to the member list (bumpMesh()) without touching
    // policyVersion or the rule set's version at all (hub/endpoints.ts's
    // `/.well-known/invite` handler calls memberStore.add + bumpMesh
    // only).
    const otherPeer = await buildTestPeer({ hubPeerId: (hub as TestHub).peer.peerId });
    try {
      await otherPeer.libp2p.dial(multiaddr(hub.peer.addrs()[0]!));
      hub.invitations.create("invite-second-member", ["member"], 60_000);
      await redeemInvitation(otherPeer, hub.peer.peerId, "invite-second-member");

      // WAIT FOR THE HEARTBEAT TO FINISH, NOT FOR IT TO START. `recordingPeer`
      // pushes a path BEFORE awaiting the call, so `calls.includes(...)` goes
      // true the moment the mesh request is ISSUED -- while `meshViewCache` is
      // only assigned once the response has been read (`join.ts`'s
      // `heartbeatOnce`). Waiting on `calls` alone therefore let the
      // assertions below race an in-flight request, and both of them read
      // state that request had not written yet: `meshView()` was still the
      // pre-redemption view, and a `/.well-known/rules` fetch that WOULD
      // have followed had not been issued, so the negative assertions could
      // pass vacuously. It held on an idle machine and failed roughly one run
      // in four once Task 14's e2e suite (six libp2p nodes, a relay and a hub
      // in this same worker) ran ahead of it and left the process busier.
      // Fixed here by observing completion: `heartbeats` increments at the END
      // of `heartbeatOnce`, so waiting for it to move past the beat that
      // issued the mesh call means every fetch that beat was going to make has
      // already been recorded in `calls`. No assertion changed.
      await vi.waitUntil(() => calls.includes("/.well-known/mesh"), {
        timeout: 5_000,
        interval: 20,
      });
      const beatThatFetchedMesh = heartbeats;
      await vi.waitUntil(() => heartbeats > beatThatFetchedMesh, {
        timeout: 5_000,
        interval: 20,
      });

      expect(calls).toContain("/.well-known/presence");
      expect(calls).toContain("/.well-known/mesh");
      // THE ASSERTION THAT MATTERS: neither counter that did NOT move was refetched.
      expect(calls).not.toContain("/.well-known/rules");
      expect(calls).not.toContain("/.well-known/revocations");

      expect(join.meshView()?.members.some((m) => m.peerId === otherPeer.peerId)).toBe(true);
    } finally {
      await otherPeer.stop();
    }
  }, 20_000);
});

describe("preDialPeer", () => {
  it("dials the exact /p2p-circuit/webrtc/p2p/<peerId> multiaddr, over a real libp2p node", async () => {
    hub = await buildTestHub();
    clientPeer = await buildTestPeer();

    // Real node, real peerId -- only `dial` itself is stubbed, because
    // this Node-side test harness has no circuit-relay-v2/webrtc
    // transport registered (that is `node-profile.ts`'s job, and it is
    // genuinely browser-only -- see this task's report §9). Stubbing
    // `dial` isolates exactly the one thing `preDialPeer` is responsible
    // for: building the right multiaddr and asking the node to dial it.
    const dialSpy = vi.spyOn(clientPeer.libp2p, "dial").mockResolvedValue({} as never);

    const relayAddr = "/ip4/127.0.0.1/tcp/9090/ws";
    const targetPeerId: PeerIdStr = hub.peer.peerId;
    await preDialPeer(clientPeer.libp2p, relayAddr, targetPeerId, { attempts: 1 });

    expect(dialSpy).toHaveBeenCalledTimes(1);
    const [dialedTarget] = dialSpy.mock.calls[0]!;
    expect(String(dialedTarget)).toBe(`${relayAddr}/p2p-circuit/webrtc/p2p/${targetPeerId}`);
  }, 10_000);
});
