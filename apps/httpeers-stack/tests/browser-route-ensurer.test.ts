/**
 * A2: `ensureRoute` on the request path.
 *
 * WHAT THIS PINS, AND WHAT IT DELIBERATELY DOES NOT. The bound and the
 * fast-failure behaviour are pinned here against a fake node, because they are
 * decisions this code makes. The two facts the design rests on -- that libp2p
 * collapses concurrent dials, and what a healthy dial costs -- are properties
 * of libp2p and the network, and were established by measurement rather than
 * by assertion (the numbers are in `join.ts`'s `ROUTE_DIAL_ATTEMPTS` comment
 * and in the A2 report). A test asserting "libp2p de-duplicates" would be
 * testing libp2p.
 *
 * THE BOUND IS REACHABLE, AND MAKING IT SO TOOK A SECOND ATTEMPT. `await`ing a
 * promise that is already rejected yields to the MICROTASK queue and never to
 * the macrotask one, so an unbounded retry loop starves vitest's own timer:
 * removing the bound hung the suite with no output, exactly as it did for A1's
 * synchronous loop. Being asynchronous does not save it, which is what I
 * assumed here first and had to correct.
 *
 * The fixture below therefore stops failing after a ceiling well past the
 * expected bound. A correct implementation never reaches it; an unbounded one
 * succeeds on a later attempt and fails the assertions immediately, with a
 * count that says how far it got.
 */

import type { Libp2p, PeerIdStr } from "@statewalker/httpeers.core";
import { describe, expect, it } from "vitest";
import {
  createRouteEnsurer,
  ROUTE_DIAL_ATTEMPTS,
  ROUTE_DIAL_TIMEOUT_MS,
} from "../src/browser/join.js";

const RELAY = "/ip4/127.0.0.1/tcp/9090/ws/p2p/12D3KooWRelay";
/** A syntactically real peer id -- `ensureRoute` decodes it before dialling. */
const PEER: PeerIdStr = "12D3KooWEefiyvWwy4EFAGfApQEZWnP4XX8tLnGn5HsJPiCJijWF";
const SELF: PeerIdStr = "12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Hra8Nc8dQjML44R";

interface FakeNode {
  node: Libp2p;
  dials: Array<{ addrs: string[]; hadSignal: boolean }>;
}

/**
 * A node whose `dial` fails `failures` times and then succeeds, and which
 * reports no existing connections so the early-out never short-circuits.
 */
function fakeNode(failures: number, connected = false): FakeNode {
  const dials: FakeNode["dials"] = [];
  const node = {
    getConnections: () => (connected ? [{ limits: undefined }] : []),
    dial: async (addrs: unknown, options?: { signal?: AbortSignal }) => {
      const list = Array.isArray(addrs) ? addrs : [addrs];
      dials.push({
        addrs: list.map((a) => String(a)),
        hadSignal: options?.signal != null,
      });
      if (dials.length <= failures) throw new Error("stalled");
      return {} as never;
    },
  } as unknown as Libp2p;
  return { node, dials };
}

const ensurer = (node: Libp2p): ((peerId: PeerIdStr) => Promise<void>) =>
  createRouteEnsurer({ node, relayAddr: RELAY, selfPeerId: SELF, meshView: () => null });

describe("ensureRoute retries a stalled dial", () => {
  it("a stall on the first attempt does not lose the route", async () => {
    // THE REGRESSION THIS CLOSES. Before A2 this branch dialled once and
    // treated a stalled WebRTC handshake as permanent, so an image fetch from a
    // peer that was there and working failed for six seconds and then showed
    // broken -- the third place in this codebase that made that mistake.
    const fake = fakeNode(1);
    await ensurer(fake.node)(PEER);
    expect(fake.dials).toHaveLength(2);
  });

  it("the bound holds -- it is not persistent", async () => {
    // THE CEILING IS IN THE FIXTURE, and it is what makes this test able to
    // fail at all: an unbounded loop would spin on rejected promises without
    // yielding to vitest's timer. Succeeding past the expected bound turns that
    // hang into an immediate, legible failure.
    const fake = fakeNode(ROUTE_DIAL_ATTEMPTS + 5);
    await expect(ensurer(fake.node)(PEER)).rejects.toThrow();
    expect(fake.dials).toHaveLength(ROUTE_DIAL_ATTEMPTS);
  });

  it("gives each attempt its own bounded budget", async () => {
    // Two attempts of ROUTE_DIAL_TIMEOUT_MS is the whole reason the bound is
    // safe: it costs what ONE uncapped libp2p attempt costs today. Without a
    // signal each attempt would take libp2p's 6 s and two would cost twelve.
    const fake = fakeNode(1);
    await ensurer(fake.node)(PEER);
    expect(fake.dials.every((d) => d.hadSignal)).toBe(true);
    expect(ROUTE_DIAL_ATTEMPTS * ROUTE_DIAL_TIMEOUT_MS).toBeLessThanOrEqual(6_000);
  });

  it("fails with a message naming the peer and what it was given", async () => {
    // `edge-dispatch.ts` swallows this by design, and its `console.warn` is
    // then the ONLY record that a route could not be built. A message that
    // does not name the peer leaves that log useless.
    const fake = fakeNode(ROUTE_DIAL_ATTEMPTS + 5);
    const message = await ensurer(fake.node)(PEER).then(
      () => "",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(message).toContain(PEER);
    expect(message).toContain(String(ROUTE_DIAL_ATTEMPTS));
    expect(message).toContain(String(ROUTE_DIAL_TIMEOUT_MS));
  });

  it("dials the /webrtc circuit address when the mesh view offers nothing", async () => {
    // The fallback branch used to call `preDialPeer` with its DEFAULT of one
    // attempt, so it was unretried too. Both branches now share one loop.
    const fake = fakeNode(1);
    await ensurer(fake.node)(PEER);
    for (const dial of fake.dials) {
      expect(dial.addrs).toEqual([`${RELAY}/p2p-circuit/webrtc/p2p/${PEER}`]);
    }
  });

  it("does not dial at all when an unlimited connection already exists", async () => {
    // The early-out is what makes the per-request call cheap once a route
    // exists -- measured at 2-8 ms, against ~583 ms for a first dial.
    const fake = fakeNode(0, true);
    await ensurer(fake.node)(PEER);
    expect(fake.dials).toHaveLength(0);
  });

  it("never dials itself", async () => {
    const fake = fakeNode(0);
    await ensurer(fake.node)(SELF);
    expect(fake.dials).toHaveLength(0);
  });
});
