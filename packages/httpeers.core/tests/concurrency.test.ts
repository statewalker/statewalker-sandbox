/**
 * T-3 (Task 18): the client-side concurrency bound made executable.
 *
 * Ledger note 18 §6 is explicit that raising `maxInboundStreams`/
 * `maxOutboundStreams` to 512 (Task 6a) moved the concurrency cliff rather
 * than removing it -- past the cap, libp2p RESETS a stream instead of
 * queueing it, so a caller sees a rejected promise instead of latency. This
 * file proves the fix from the CALLER's side: `createRemote` now queues
 * excess outbound calls behind an in-process semaphore
 * (`DEFAULT_MAX_CONCURRENT_OUTBOUND`, see `transport-duplex.ts`) instead of
 * ever letting them race each other into that cliff.
 *
 * Every test here runs against real libp2p nodes over loopback TCP -- no
 * mocks of the transport, the same discipline `peer.test.ts` and
 * `errors.test.ts` established.
 */
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import type { Libp2p } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { createLibp2p } from "libp2p";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PeerRequestTimeoutError, PeerStreamResetError, PeerUnreachableError } from "../src/index.js";
import { createMounts } from "../src/router.js";
import { createRemote, serveTransport } from "../src/transport-duplex.js";
import { json } from "../src/types.js";

async function node(listen: boolean): Promise<Libp2p> {
  return createLibp2p({
    addresses: listen ? { listen: ["/ip4/127.0.0.1/tcp/0"] } : {},
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("T-3: the outbound semaphore", () => {
  let clientA: Libp2p;
  const toStop: Array<Libp2p | { stop: () => Promise<void> }> = [];

  beforeEach(async () => {
    clientA = await node(false);
  });

  afterEach(async () => {
    await Promise.allSettled([...toStop.splice(0), clientA].map((x) => x.stop()));
  });

  it(
    "load past the width degrades gracefully: every call completes late rather than failing, and the peak concurrent stream count never exceeds the configured width",
    async () => {
      // This is the test whose absence let the original cliff hide (Task 18
      // brief): fifty-odd earlier tests passed while every one of them was
      // sequential. Here, MORE calls than the semaphore's width are fired in
      // one tick, deliberately.
      const server = await node(true);
      const mounts = createMounts();
      const state = { active: 0, peak: 0 };
      const HOLD_MS = 150;
      mounts.provide("/slow", async () => {
        state.active++;
        state.peak = Math.max(state.peak, state.active);
        await sleep(HOLD_MS);
        state.active--;
        return json({ ok: true });
      });
      const stopServing = await serveTransport({
        node: server,
        dispatch: async (req) => mounts.match(new URL(req.url).pathname)?.(req) ?? json({}, 404),
        // Generous -- the server's own inbound cap must not be the
        // bottleneck here; this test is about the CLIENT's own admission
        // control, not the server-side cap Task 17's row 3b already covers.
        maxInboundStreams: 100,
      });
      toStop.push({ stop: stopServing }, server);

      const addr = server.getMultiaddrs()[0];
      if (addr == null) throw new Error("server has no listen address");
      await clientA.dial(addr);
      const serverPeerId = server.peerId.toString();

      const WIDTH = 3;
      const CALLS = 9; // 3 full "waves" through a width-3 semaphore
      const remote = createRemote({ node: clientA, maxConcurrentOutbound: WIDTH, maxOutboundStreams: 100 });

      const start = Date.now();
      const results = await Promise.allSettled(
        Array.from({ length: CALLS }, () => remote(serverPeerId, new Request("http://peer/slow"))),
      );
      const elapsed = Date.now() - start;

      // Graceful degradation: nothing failed. Every one of the 9 calls
      // completed -- late, not rejected -- and the far end never observed a
      // reset (a reset would have surfaced here as a rejection mapped to
      // PeerStreamResetError, same as errors.test.ts's "row 3").
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(0);
      expect(results.every((r) => r.status === "fulfilled" && r.value.ok)).toBe(true);

      // The semaphore actually bound admission: never more than WIDTH
      // requests inside the handler at once, even though 9 were fired at
      // once and the server itself would have allowed up to 100.
      expect(state.peak).toBeLessThanOrEqual(WIDTH);
      expect(state.peak).toBeGreaterThan(0);

      // Proves queueing actually happened (as opposed to "coincidentally
      // fast enough that width never mattered"): 9 calls through a width-3
      // gate, each held HOLD_MS, take at least 3 serialized waves --
      // comfortably more than a single wave's worth of time.
      expect(elapsed).toBeGreaterThanOrEqual(Math.ceil(CALLS / WIDTH) * HOLD_MS * 0.8);
    },
    15_000,
  );

  it(
    "a permit is released after a failed call -- one bad target never permanently strands a slot for calls after it",
    async () => {
      const server = await node(true);
      const mounts = createMounts();
      mounts.provide("/fast", async () => json({ ok: true }));
      const stopServing = await serveTransport({
        node: server,
        dispatch: async (req) => mounts.match(new URL(req.url).pathname)?.(req) ?? json({}, 404),
      });
      toStop.push({ stop: stopServing }, server);

      const addr = server.getMultiaddrs()[0];
      if (addr == null) throw new Error("server has no listen address");
      await clientA.dial(addr);
      const serverPeerId = server.peerId.toString();

      // Width 1: the second call can only proceed once the first call's
      // permit is released -- whether that first call succeeded or failed.
      const remote = createRemote({ node: clientA, maxConcurrentOutbound: 1 });

      // A well-formed peerId this node has no address for at all -- same
      // shape as errors.test.ts's row 1a, guaranteed to fail fast with
      // PeerUnreachableError rather than some other, slower condition.
      const unknownKey = await generateKeyPair("Ed25519");
      const unknownPeerId = peerIdFromPrivateKey(unknownKey).toString();
      await expect(remote(unknownPeerId, new Request("http://peer/x"))).rejects.toBeInstanceOf(
        PeerUnreachableError,
      );

      // If the failed first call had leaked its permit, this would hang
      // until the test's own timeout -- it must resolve promptly instead.
      const second = await remote(serverPeerId, new Request("http://peer/fast"));
      expect(second.ok).toBe(true);
    },
    15_000,
  );

  it(
    "row 3a: this client's own outbound cap trips synchronously-in-effect (not queued) and surfaces as PeerStreamResetError",
    async () => {
      // Proves Task 17's row 3a end to end (previously inspection-backed
      // only, deferred here): the OUTBOUND cap is `maxOutboundStreams`
      // (libp2p's own per-connection limit), distinct from the semaphore's
      // `maxConcurrentOutbound` (this package's own admission queue). Set
      // the semaphore wide open (10) so it never queues anything, and the
      // libp2p cap itself deliberately tight (1) so the second concurrent
      // stream trips `TooManyOutboundProtocolStreamsError` for real.
      const server = await node(true);
      const mounts = createMounts();
      mounts.provide("/slow", async () => {
        await sleep(300);
        return json({ ok: true });
      });
      const stopServing = await serveTransport({
        node: server,
        dispatch: async (req) => mounts.match(new URL(req.url).pathname)?.(req) ?? json({}, 404),
        // Generous -- the server's inbound cap must not be what trips here.
        maxInboundStreams: 10,
      });
      toStop.push({ stop: stopServing }, server);

      const addr = server.getMultiaddrs()[0];
      if (addr == null) throw new Error("server has no listen address");
      await clientA.dial(addr);
      const serverPeerId = server.peerId.toString();

      const remote = createRemote({
        node: clientA,
        maxOutboundStreams: 1, // libp2p's own per-connection cap -- the thing under test
        maxConcurrentOutbound: 10, // wide open -- must not be the bottleneck
      });

      const results = await Promise.allSettled([
        remote(serverPeerId, new Request("http://peer/slow")),
        remote(serverPeerId, new Request("http://peer/slow")),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(PeerStreamResetError);
      expect(rejected[0]?.reason).toMatchObject({ kind: "stream-reset" });
    },
    15_000,
  );

  it(
    "the at-limit contract: calls that cannot get a permit within requestTimeoutMs reject with PeerRequestTimeoutError -- bounded, never an unbounded queue, never a silent reset",
    async () => {
      // Deliberately no manual gate/release: `first`, `second`, ... all
      // share ONE `requestTimeoutMs` budget (T-3's design decision -- see
      // `DEFAULT_MAX_CONCURRENT_OUTBOUND`'s doc comment), so the only way to
      // prove "a call queued too long times out" without ALSO tripping the
      // in-flight call's own deadline is to let real queueing arithmetic do
      // it: width 1, a handler that takes HOLD_MS, and enough concurrent
      // calls that later ones in the FIFO queue accumulate more wait than
      // requestTimeoutMs purely from waiting their turn.
      const server = await node(true);
      const mounts = createMounts();
      const HOLD_MS = 60;
      mounts.provide("/fast", async () => {
        await sleep(HOLD_MS);
        return json({ ok: true });
      });
      const stopServing = await serveTransport({
        node: server,
        dispatch: async (req) => mounts.match(new URL(req.url).pathname)?.(req) ?? json({}, 404),
      });
      toStop.push({ stop: stopServing }, server);

      const addr = server.getMultiaddrs()[0];
      if (addr == null) throw new Error("server has no listen address");
      await clientA.dial(addr);
      const serverPeerId = server.peerId.toString();

      const REQUEST_TIMEOUT_MS = 200;
      const remote = createRemote({
        node: clientA,
        maxConcurrentOutbound: 1,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });

      // 6 calls x 60ms sequential (width 1) = 360ms of total queue-to-finish
      // time, comfortably past the 200ms budget -- some calls must reject.
      const CALLS = 6;
      const start = Date.now();
      const results = await Promise.allSettled(
        Array.from({ length: CALLS }, () => remote(serverPeerId, new Request("http://peer/fast"))),
      );
      const elapsed = Date.now() - start;

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      // Never a silent reset and never anything left waiting indefinitely:
      // whatever did NOT complete rejects with the SAME typed timeout error
      // an unresponsive peer would produce (row 5's class) -- nothing
      // reaches PeerStreamResetError, nothing hangs past the test's own
      // timeout.
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(PeerRequestTimeoutError);
        expect(r.reason).toMatchObject({ kind: "request-timeout" });
      }
      // The width still let genuinely-fitting calls through -- this is not
      // "queue rejects everything", only what cannot fit in the budget.
      expect(fulfilled.length).toBeGreaterThan(0);
      // And the bound genuinely bit: not everything fit in 200ms, so at
      // least one call was queued long enough to time out rather than left
      // waiting for a permit indefinitely.
      expect(rejected.length).toBeGreaterThan(0);
      // Bounded: nothing waits meaningfully longer than requestTimeoutMs --
      // proves the queue wait shares ONE budget with the rest of the call,
      // not a second, independent timer stacked on top (which would let
      // this run closer to 2x requestTimeoutMs, or CALLS * HOLD_MS,
      // instead).
      expect(elapsed).toBeLessThan(REQUEST_TIMEOUT_MS + 200);
    },
    15_000,
  );
});
