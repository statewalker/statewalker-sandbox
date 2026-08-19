/**
 * T-2: the failure -> observation table, made executable.
 *
 * Every test here provokes the REAL condition against real libp2p nodes
 * over loopback TCP -- no mocks of the transport, following the same
 * discipline `peer.test.ts` established ("two real nodes ... no mocks").
 * The one exception is the last describe block, which unit-tests
 * `mapPeerCallError`'s own fallback contract directly (see its comment for
 * why that is not the same thing as faking a row).
 *
 * See the Task 17 report (`.superpowers/sdd/2026-08-18-httpeers-stack/
 * task-17-report.md`) for the full failure -> observation table this file
 * implements, including the two rows this file deliberately does NOT test
 * (relay data-limit exceeded: no relay transport in this stack; the
 * concurrency cliff at N=512 itself: Task 18's job, not this one's -- row 4
 * below proves the same code path at a small, fast N instead).
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
import {
  PeerBindingLostError,
  PeerCallError,
  PeerProtocolUnsupportedError,
  PeerRequestTimeoutError,
  PeerStreamResetError,
  PeerUnreachableError,
  UnknownPeerCallError,
} from "../src/index.js";
import { createMounts } from "../src/router.js";
import { createRemote, mapPeerCallError, serveTransport } from "../src/transport-duplex.js";
import { createPeer, type Peer } from "../src/peer.js";
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

describe("T-2: failure -> observation", () => {
  let clientA: Libp2p;
  const toStop: Array<Libp2p | { stop: () => Promise<void> }> = [];

  beforeEach(async () => {
    clientA = await node(false);
  });

  afterEach(async () => {
    await Promise.allSettled([...toStop.splice(0), clientA].map((x) => x.stop()));
  });

  // --- row 1: peer offline / undialable -------------------------------------

  it("row 1a: a peerId this node has no address for surfaces as PeerUnreachableError (NoValidAddressesError)", async () => {
    const unknownKey = await generateKeyPair("Ed25519");
    const unknownPeerId = peerIdFromPrivateKey(unknownKey).toString();

    const remote = createRemote({ node: clientA });
    const call = remote(unknownPeerId, new Request("http://peer/x"));

    await expect(call).rejects.toBeInstanceOf(PeerUnreachableError);
    await expect(call).rejects.toMatchObject({ kind: "peer-unreachable", peerId: unknownPeerId });
  }, 10_000);

  it("row 1b: a peer that WAS reachable and has since gone offline surfaces as PeerUnreachableError (dial-queue AggregateError)", async () => {
    const server = await node(true);
    toStop.push(server);
    const addr = server.getMultiaddrs()[0];
    if (addr == null) throw new Error("server has no listen address");
    const serverPeerId = server.peerId.toString();

    // Establish the address in clientA's peerStore, then hang up cleanly --
    // `remote()` dials by bare peerId, which only ever works once an
    // address is already known (see `Peer.libp2p`'s own doc comment).
    await clientA.dial(addr);
    await clientA.hangUp(server.peerId);
    await server.stop(); // now genuinely offline; the port stops accepting

    const remote = createRemote({ node: clientA });
    const call = remote(serverPeerId, new Request("http://peer/x"));

    await expect(call).rejects.toBeInstanceOf(PeerUnreachableError);
    await expect(call).rejects.toMatchObject({ kind: "peer-unreachable", peerId: serverPeerId });
  }, 15_000);

  // --- row 2: protocol unsupported by the remote -----------------------------

  it("row 2: a real, reachable peer that never registered /httpeers/1.0.0 surfaces as PeerProtocolUnsupportedError", async () => {
    // A bare libp2p node -- reachable, but `serveTransport` was never called
    // on it, so it never called `node.handle(PROTOCOL, ...)`.
    const bareServer = await node(true);
    toStop.push(bareServer);
    const addr = bareServer.getMultiaddrs()[0];
    if (addr == null) throw new Error("bare server has no listen address");
    await clientA.dial(addr);

    const remote = createRemote({ node: clientA });
    const call = remote(bareServer.peerId.toString(), new Request("http://peer/x"));

    await expect(call).rejects.toBeInstanceOf(PeerProtocolUnsupportedError);
    await expect(call).rejects.toMatchObject({ kind: "protocol-unsupported" });
  }, 15_000);

  // --- row 3: stream reset, including the concurrency cliff's mechanism -----

  it("row 3: a stream past the server's inbound cap is reset, not queued, and the caller sees PeerStreamResetError", async () => {
    // The exact mechanism behind ledger note 18's 512-stream concurrency
    // cliff (`TooManyInboundProtocolStreamsError`, aborted server-side) --
    // reproduced here at N=1 for a fast, deterministic test. Reproducing
    // the cliff itself at N=512, and any hardening around it, is Task 18's
    // job; this proves the OBSERVATION the taxonomy promises: whichever N
    // trips it, the caller gets this typed error, never a raw
    // `StreamResetError`.
    const server = await node(true);
    const mounts = createMounts();
    // Held open deliberately, so a second concurrent stream is genuinely
    // concurrent with the first when the server's inbound-stream count is
    // checked -- if the first request already completed (and its stream
    // closed) before the second one opens, the count never exceeds the cap.
    mounts.provide("/slow", async () => {
      await sleep(300);
      return json({ ok: true });
    });
    const stopServing = await serveTransport({
      node: server,
      dispatch: async (req) => mounts.match(new URL(req.url).pathname)?.(req) ?? json({}, 404),
      maxInboundStreams: 1,
    });
    toStop.push({ stop: stopServing }, server);

    const addr = server.getMultiaddrs()[0];
    if (addr == null) throw new Error("server has no listen address");
    await clientA.dial(addr);
    const serverPeerId = server.peerId.toString();

    // Client's own outbound cap must not be the thing that trips -- give it
    // plenty of headroom so only the server's inbound cap (1) is in play.
    const remote = createRemote({ node: clientA, maxOutboundStreams: 10 });
    const results = await Promise.allSettled([
      remote(serverPeerId, new Request("http://peer/slow")),
      remote(serverPeerId, new Request("http://peer/slow")),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(PeerStreamResetError);
    expect(rejected[0]?.reason).toMatchObject({ kind: "stream-reset" });
  }, 15_000);

  // --- row 5: request timeout ------------------------------------------------

  it("row 5: a peer that never answers is given up on after requestTimeoutMs, as PeerRequestTimeoutError", async () => {
    const server = await node(true);
    const stopServing = await serveTransport({
      node: server,
      dispatch: () => new Promise<Response>(() => {}), // never resolves
    });
    toStop.push({ stop: stopServing }, server);

    const addr = server.getMultiaddrs()[0];
    if (addr == null) throw new Error("server has no listen address");
    await clientA.dial(addr);
    const serverPeerId = server.peerId.toString();

    const remote = createRemote({ node: clientA, requestTimeoutMs: 200 });
    const start = Date.now();
    const call = remote(serverPeerId, new Request("http://peer/never"));

    await expect(call).rejects.toBeInstanceOf(PeerRequestTimeoutError);
    await expect(call).rejects.toMatchObject({ kind: "request-timeout" });
    // Bounded, not exact -- proves the caller was not left waiting far past
    // its own configured timeout, without pinning an exact millisecond.
    expect(Date.now() - start).toBeLessThan(2_000);
  }, 15_000);

  // --- row 6: binding lost (a bug, not a network condition) ------------------

  it("row 6: a Request that reaches the binding middleware without ever being registered throws PeerBindingLostError, not a 401/403", async () => {
    const server = await node(true);
    const mounts = createMounts();
    mounts.provide("/test", async () => json({ ok: true }));
    const serverPeer: Peer = await createPeer({ node: server, mounts });
    toStop.push(serverPeer);

    // Calls `dispatch` directly -- the exact re-creation-without-
    // `copyPeerBinding` scenario `PeerBindingLostError`'s own doc comment
    // describes: nothing here ever called `registerPeer`/`registerAnonymous`
    // on this `Request`, because it never passed through
    // `serveTransport`'s per-stream closure at all.
    const req = new Request("http://peer/test/whoami");
    await expect(serverPeer.dispatch(req)).rejects.toBeInstanceOf(PeerBindingLostError);
  }, 15_000);
});

describe("mapPeerCallError: the fallback contract", () => {
  // Not a row -- this tests OUR OWN default-case logic (`Peer.call()` /
  // `Remote` must never leak a raw transport exception, even one nobody has
  // enumerated a row for yet), not a specific network condition. Compare
  // the deliberate absence of any such test for `PeerRelayLimitExceededError`
  // in the suite above: that class's *mapping* is real production code, but
  // asserting `mapPeerCallError({name:"TransferLimitError"}) ->
  // PeerRelayLimitExceededError` in isolation would only prove the switch
  // statement was typed correctly, not that the condition it names can ever
  // occur in this stack -- see the Task 17 report.
  it("wraps an unrecognised error as UnknownPeerCallError, preserving it as `cause`", () => {
    const mystery = new Error("something libp2p has never thrown before");
    const wrapped = mapPeerCallError(mystery, "12D3KooWSomePeer");

    expect(wrapped).toBeInstanceOf(UnknownPeerCallError);
    expect(wrapped).toBeInstanceOf(PeerCallError);
    expect(wrapped.kind).toBe("unknown");
    expect(wrapped.peerId).toBe("12D3KooWSomePeer");
    expect(wrapped.cause).toBe(mystery);
  });

  it("passes an already-mapped PeerCallError through unchanged", () => {
    const already = new PeerUnreachableError("12D3KooWSomePeer");
    expect(mapPeerCallError(already, "12D3KooWSomePeer")).toBe(already);
  });
});
