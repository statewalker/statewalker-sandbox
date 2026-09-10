/**
 * Unit coverage for `src/mesh.ts`, written for the 2026-09-09 adoption (MESH-2).
 * NOT RECOVERED CODE — the export shipped no unit test for this file either.
 *
 * `mesh.ts` is the larger of the two untested files and the harder one, for a
 * reason worth recording: **its three testable units are module-private.**
 * `reusablePeer`, `dialAnyRelay` and `waitForCircuitAddress` are not exported,
 * so the only seam into them is `startPeer`, and `startPeer` builds a real
 * libp2p node. That is why the export has integration coverage and nothing
 * else, and it is a property of the file rather than an oversight in the
 * session.
 *
 * THE CHOICE MADE HERE, AND THE ONE REJECTED. Adding `export` to three
 * functions would have been one character each and would have let them be
 * called directly — but it edits recovered code to suit a test, and the
 * functions would then be tested somewhere other than where they are used.
 * Instead the three MODULE BOUNDARIES are mocked — `libp2p`,
 * `@statewalker/webrun-streams-libp2p` and `@statewalker/webrun-http-streams` —
 * and every test drives the real `startPeer` through its real call sites.
 * `src/mesh.ts` is byte-identical to the export; nothing about it is adapted
 * for testability.
 *
 * What is NOT mocked, deliberately: `@multiformats/multiaddr` and
 * `@libp2p/peer-id`. Address parsing and peer-id validation are exactly what
 * finding two's logic turns on, so faking them would test the fake.
 *
 * CLAIMS AND THEIR SOURCES (§5.1 — written from the record, not the code):
 *   - note 08 §4, finding one: the five-call ceiling and its mitigation
 *   - note 08 §5, finding two: address for first contact, peer id afterwards
 *   - note 08 §7: libp2p 3.x hands handlers `(stream, connection)`
 *   - note 10 §4: dial the published addresses in order, succeed on the first,
 *     and report every error when all fail
 *   - `mesh.ts`'s module comment: why `runOnLimitedConnection` is everywhere,
 *     and why a browser peer needs the relay at all
 *   - `waitForCircuitAddress`'s and `fetch`'s own stated contracts
 *
 * On the red step, see `hub.test.ts`'s header: the same applies, and the §5.3
 * mutation pass is what stands in for it.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Connection, PeerId } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { Multiaddr } from "@multiformats/multiaddr";
import { multiaddr } from "@multiformats/multiaddr";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- the three module boundaries -------------------------------------------

const createLibp2p = vi.fn();
const connect = vi.fn();
const serveConnections = vi.fn();
const fetchOverDuplex = vi.fn();
const serveFetchOverDuplex = vi.fn();

vi.mock("libp2p", () => ({ createLibp2p: (cfg: unknown) => createLibp2p(cfg) }));
vi.mock("@statewalker/webrun-streams-libp2p", () => ({
  connect: (init: unknown) => connect(init),
  serveConnections: (init: unknown, make: unknown) => serveConnections(init, make),
}));
vi.mock("@statewalker/webrun-http-streams", () => ({
  fetchOverDuplex: (call: unknown, request: unknown) => fetchOverDuplex(call, request),
  serveFetchOverDuplex: (handler: unknown) => serveFetchOverDuplex(handler),
}));

const { json, startPeer } = await import("../src/mesh.js");

// --- a libp2p node that does nothing but answer questions ------------------

const newPeerId = async (): Promise<PeerId> =>
  peerIdFromPrivateKey(await generateKeyPair("Ed25519"));

let SELF: PeerId;
let HUB: PeerId;
let RELAY: PeerId;

interface FakeNode {
  peerId: PeerId;
  /** Every multiaddr `node.dial` was called with, in order. */
  dialed: string[];
  /** Addresses whose dial should reject, by substring. */
  dialFailures: string[];
  /** What `getMultiaddrs()` reports — reassignable mid-test. */
  addrs: string[];
  /** Open connections, keyed by peer id string. */
  connections: Map<string, Connection[]>;
  /** Connections closed via `connection.close()`, in order. */
  closed: string[];
  dial: (ma: Multiaddr) => Promise<void>;
  getConnections: (peerId?: PeerId) => Connection[];
  getMultiaddrs: () => Multiaddr[];
  stop: () => Promise<void>;
  stopped: boolean;
}

function fakeConnection(node: FakeNode, label: string, limits: unknown): Connection {
  return {
    limits,
    async close() {
      node.closed.push(label);
    },
  } as unknown as Connection;
}

function fakeNode(peerId: PeerId, addrs: string[] = []): FakeNode {
  const node: FakeNode = {
    peerId,
    dialed: [],
    dialFailures: [],
    addrs,
    connections: new Map(),
    closed: [],
    stopped: false,
    async dial(ma) {
      const s = ma.toString();
      node.dialed.push(s);
      const failure = node.dialFailures.find((f) => s.includes(f));
      if (failure != null) throw new Error(`dial refused: ${failure}`);
    },
    getConnections(id) {
      if (id == null) return [...node.connections.values()].flat();
      return node.connections.get(id.toString()) ?? [];
    },
    getMultiaddrs: () => node.addrs.map((a) => multiaddr(a)),
    async stop() {
      node.stopped = true;
    },
  };
  return node;
}

/** Wire the mocks to a node and a default response, and return the node. */
function useNode(addrs: string[]): FakeNode {
  const node = fakeNode(SELF, addrs);
  createLibp2p.mockImplementation(async () => node);
  serveConnections.mockResolvedValue(undefined);
  serveFetchOverDuplex.mockImplementation((h: unknown) => ({ duplexFor: h }));
  connect.mockResolvedValue({ call: "the-duplex-call", close: vi.fn(async () => {}) });
  fetchOverDuplex.mockResolvedValue(new Response("{}", { status: 200 }));
  return node;
}

const CIRCUIT = () => `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}/p2p-circuit/p2p/${SELF}`;
const WEBRTC = () => `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${SELF}`;
const HUB_ADDRESS = () => `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}/p2p-circuit/p2p/${HUB}`;

const noopHandler = async () => new Response("ok");

beforeEach(async () => {
  vi.clearAllMocks();
  SELF = await newPeerId();
  HUB = await newPeerId();
  RELAY = await newPeerId();
});

// ---------------------------------------------------------------------------
// Note 10 §4: "dials them in order, succeeding on the first — a document may
// list several (IPv4 and IPv6, say) and a peer on a network without one must
// not be stopped by it. All addresses failing reports every error, which is the
// difference between 'the relay is unreachable' and 'the first of three did not
// work'."
// ---------------------------------------------------------------------------

describe("dialling the relay", () => {
  it("stops at the first address that works, and does not dial the rest", async () => {
    const node = useNode([CIRCUIT()]);
    await startPeer({
      relay: `/ip4/10.0.0.1/tcp/1/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    expect(node.dialed).toHaveLength(1);
  });

  it("falls through to a later address when an earlier one fails", async () => {
    // A multiaddr relay resolves to one address, so the several-addresses case
    // needs the document form. `resolveRelayAddrs` is exercised for real here —
    // only `fetch` is stubbed, because the list is what this test is about.
    const node = useNode([CIRCUIT()]);
    node.dialFailures = ["10.0.0.1"];
    const doc = {
      relayAddrs: [`/ip4/10.0.0.1/tcp/1/ws/p2p/${RELAY}`, `/ip4/10.0.0.2/tcp/2/ws/p2p/${RELAY}`],
    };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(doc)));
    try {
      const peer = await startPeer({
        relay: "https://relay.test",
        transports: [],
        handler: noopHandler,
      });
      expect(node.dialed.map((d) => d.split("/")[2])).toEqual(["10.0.0.1", "10.0.0.2"]);
      expect(peer.relayAddrs).toEqual(doc.relayAddrs);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("when every address fails, the error names every address AND every error", async () => {
    // FINAL-ITERATION PATH (§5.3): the report must include the LAST failure,
    // not only the first. A loop that overwrote its failure list, or reported
    // only `failures[0]`, would pass a one-address test.
    const node = useNode([CIRCUIT()]);
    node.dialFailures = ["10.0.0.1", "10.0.0.2", "10.0.0.3"];
    const relayAddrs = [
      `/ip4/10.0.0.1/tcp/1/ws/p2p/${RELAY}`,
      `/ip4/10.0.0.2/tcp/2/ws/p2p/${RELAY}`,
      `/ip4/10.0.0.3/tcp/3/ws/p2p/${RELAY}`,
    ];
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ relayAddrs })));
    try {
      const err = await startPeer({
        relay: "https://relay.test",
        transports: [],
        handler: noopHandler,
      }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain("could not dial the relay at any published address");
      for (const addr of relayAddrs) expect(message).toContain(addr);
      expect(message).toContain("10.0.0.3"); // the LAST one, named
      expect(message).toContain("dial refused: 10.0.0.1");
      expect(message).toContain("dial refused: 10.0.0.3");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// "Prefers a `/webrtc` address when one appears: that is the one another
// browser peer should dial, because dialling it upgrades the connection off
// the relay. Falls back to the plain circuit address, which is what a Node peer
// without the WebRTC transport gets." — waitForCircuitAddress.
// ---------------------------------------------------------------------------

describe("the reserved address", () => {
  it("prefers the /webrtc address when both are advertised", async () => {
    useNode([CIRCUIT(), WEBRTC()]);
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    expect(peer.address).toBe(WEBRTC());
  });

  it("prefers /webrtc even when the plain circuit is advertised first", async () => {
    // Order-independence, asserted: the preference must be by SHAPE, not by
    // position in `getMultiaddrs()`.
    useNode([WEBRTC(), CIRCUIT()]);
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    expect(peer.address).toBe(WEBRTC());
  });

  it("falls back to the plain circuit address when there is no /webrtc", async () => {
    // SYMMETRIC PAIR with the two above — this is the Node peer's case, and it
    // is the one `node-verify.mjs` actually runs.
    useNode([CIRCUIT()]);
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    expect(peer.address).toBe(CIRCUIT());
  });

  it("waits for the reservation rather than reading getMultiaddrs once", async () => {
    // The reservation "appears asynchronously AFTER dial resolves" — so a
    // single read would fail on a real relay and pass against a fake that was
    // ready up front. The node starts with a non-circuit address only.
    const node = useNode([`/ip4/1.2.3.4/tcp/443/ws/p2p/${SELF}`]);
    setTimeout(() => {
      node.addrs = [CIRCUIT()];
    }, 350);
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
      reservationTimeoutMs: 5_000,
    });
    expect(peer.address).toBe(CIRCUIT());
  });

  it("gives up after reservationTimeoutMs, saying what it means", async () => {
    useNode([`/ip4/1.2.3.4/tcp/443/ws/p2p/${SELF}`]);
    await expect(
      startPeer({
        relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
        transports: [],
        handler: noopHandler,
        reservationTimeoutMs: 10,
      }),
    ).rejects.toThrow(/no circuit reservation within timeout/);
  });
});

// ---------------------------------------------------------------------------
// Note 08 §5, finding two: "Dialling a circuit multiaddr always asks the relay
// for a *new* hop, even when a connection to that peer is already open. …
// Passing the **peer id** lets libp2p reuse what it holds, in either direction."
// ---------------------------------------------------------------------------

describe("finding two: address for first contact, peer id afterwards", () => {
  async function peerWithConnectionTo(target: PeerId | null) {
    const node = useNode([CIRCUIT()]);
    if (target != null)
      node.connections.set(target.toString(), [fakeConnection(node, "to-target", undefined)]);
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    return { node, peer };
  }

  const dialedPeerArg = () => connect.mock.calls.at(-1)?.[0]?.peer;

  it("dials the PEER ID when a connection to it is already open", async () => {
    const { peer } = await peerWithConnectionTo(HUB);
    await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    const arg = dialedPeerArg();
    // A PeerId, not a Multiaddr: the whole finding is that these are different
    // requests to libp2p, so asserting the TYPE is asserting the fix.
    expect(String(arg)).toBe(HUB.toString());
    expect(String(arg)).not.toContain("p2p-circuit");
  });

  it("dials the full MULTIADDR when nothing is connected yet", async () => {
    // SYMMETRIC PAIR: first contact, the other half of the finding's name.
    const { peer } = await peerWithConnectionTo(null);
    await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(String(dialedPeerArg())).toBe(HUB_ADDRESS());
  });

  it("dials the multiaddr when a connection exists to a DIFFERENT peer", async () => {
    // "names one we have never met" — holding a connection to somebody else
    // must not be mistaken for holding one to the target.
    const other = await newPeerId();
    const { peer } = await peerWithConnectionTo(other);
    await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(String(dialedPeerArg())).toBe(HUB_ADDRESS());
  });

  it("dials the multiaddr when the address names no peer at all", async () => {
    const { peer } = await peerWithConnectionTo(HUB);
    const bare = "/ip4/1.2.3.4/tcp/443/ws";
    await peer.fetch(bare, new Request("http://hub/hello"));
    expect(String(dialedPeerArg())).toBe(bare);
  });

  it("dials the multiaddr when the trailing peer id is malformed", async () => {
    // "or is malformed — every case meaning 'dial the address'." A throw from
    // `peerIdFromString` must be caught, not propagated.
    const { peer } = await peerWithConnectionTo(HUB);
    const bad = "/ip4/1.2.3.4/tcp/443/ws/p2p/not-a-peer-id";
    await expect(peer.fetch(bad, new Request("http://hub/hello"))).resolves.toBeInstanceOf(
      Response,
    );
    expect(String(dialedPeerArg())).toBe(bad);
  });

  it("only the TRAILING /p2p/ counts — a relay id mid-address is not the target", async () => {
    // The address shape is `/…/p2p/<relay>/p2p-circuit/p2p/<target>`, so a
    // match that was not anchored at the end would reuse a connection to the
    // RELAY and send the request to the wrong peer entirely.
    const node = useNode([CIRCUIT()]);
    node.connections.set(RELAY.toString(), [fakeConnection(node, "to-relay", undefined)]);
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(String(dialedPeerArg())).toBe(HUB_ADDRESS());
  });
});

// ---------------------------------------------------------------------------
// Note 08 §4, finding one: "A reused raw circuit stops accepting new streams
// after exactly five calls … Mitigation in `src/mesh.ts`: retry once on a fresh
// dial, dropping limited connections first."
// ---------------------------------------------------------------------------

describe("finding one: retry once on a fresh dial", () => {
  async function peerThatFailsFirstCall(connections: Array<[string, unknown]>) {
    const node = useNode([CIRCUIT()]);
    node.connections.set(
      HUB.toString(),
      connections.map(([label, limits]) => fakeConnection(node, label, limits)),
    );
    let attempt = 0;
    connect.mockImplementation(async () => {
      attempt++;
      if (attempt === 1)
        throw new Error("EncryptionFailedError: The operation was aborted due to timeout");
      return { call: "duplex", close: vi.fn(async () => {}) };
    });
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    return { node, peer, attempts: () => attempt };
  }

  it("a failed first call is retried, and the retry uses the MULTIADDR", async () => {
    // Not the peer id: the connection that just failed is exactly the thing
    // being discarded, so retrying by peer id would reuse it.
    const { peer, attempts } = await peerThatFailsFirstCall([["limited", { data: 1n }]]);
    const res = await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(res.status).toBe(200);
    expect(attempts()).toBe(2);
    expect(String(connect.mock.calls.at(-1)?.[0]?.peer)).toBe(HUB_ADDRESS());
  });

  it("the retry closes LIMITED connections", async () => {
    const { node, peer } = await peerThatFailsFirstCall([["limited", { data: 1n }]]);
    await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(node.closed).toEqual(["limited"]);
  });

  it("the retry leaves UNLIMITED connections alone", async () => {
    // SYMMETRIC PAIR (§5.3), and it matters in the real case this code is for:
    // a browser pair that upgraded to WebRTC holds an UNLIMITED connection, and
    // closing it on every transient failure would throw away the upgrade the
    // whole design exists to reach.
    const { node, peer } = await peerThatFailsFirstCall([["unlimited", undefined]]);
    await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(node.closed).toEqual([]);
  });

  it("with both kinds held, it closes only the limited one", async () => {
    const { node, peer } = await peerThatFailsFirstCall([
      ["unlimited", undefined],
      ["limited", { data: 1n }],
    ]);
    await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(node.closed).toEqual(["limited"]);
  });

  it("retries ONCE, not forever: a second failure propagates", async () => {
    // "retry once, always" — an unbounded retry would turn a dead relay into a
    // hang, which is the failure mode the five-call ceiling already produces
    // once.
    useNode([CIRCUIT()]);
    let attempt = 0;
    connect.mockImplementation(async () => {
      attempt++;
      throw new Error(`attempt ${attempt} failed`);
    });
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    await expect(peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"))).rejects.toThrow(
      "attempt 2 failed",
    );
    expect(attempt).toBe(2);
  });

  it("a call that succeeds first time closes nothing and does not retry", async () => {
    // The other side of the pair again: the mitigation must be inert on the
    // happy path, or every call would drop the connection it just used.
    const node = useNode([CIRCUIT()]);
    node.connections.set(HUB.toString(), [fakeConnection(node, "limited", { data: 1n })]);
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(node.closed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// "Buffer the body before releasing the transport: `close()` tears down the
// streams this call owns, and a streamed body still being read from one of them
// would be truncated." — mesh.ts, inside `callOnce`.
// ---------------------------------------------------------------------------

describe("the response is buffered before the transport is released", () => {
  it("the body is readable after close(), and close() ran first", async () => {
    useNode([CIRCUIT()]);
    const order: string[] = [];
    const close = vi.fn(async () => {
      order.push("close");
    });
    connect.mockResolvedValue({ call: "duplex", close });
    fetchOverDuplex.mockImplementation(async () => {
      order.push("fetch");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"from":"hub-tab"}'));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });

    const res = await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    // The transport is already gone by the time the caller reads.
    expect(order).toEqual(["fetch", "close"]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ from: "hub-tab" });
  });

  it("status, statusText and headers survive the rebuild", async () => {
    // The buffering constructs a NEW Response, so everything on the old one
    // has to be carried across by hand — exactly the kind of place a field is
    // quietly dropped.
    useNode([CIRCUIT()]);
    fetchOverDuplex.mockResolvedValue(
      new Response('{"error":"not-a-member"}', {
        status: 403,
        statusText: "Forbidden By Mesh",
        headers: { "content-type": "application/json", "x-hub": "hub-tab" },
      }),
    );
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    const res = await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(res.status).toBe(403);
    expect(res.statusText).toBe("Forbidden By Mesh");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-hub")).toBe("hub-tab");
    expect(await res.json()).toEqual({ error: "not-a-member" });
  });

  it("close() still runs when the call throws", async () => {
    // SYMMETRIC PAIR: it is in a `finally`, and the failure path is the one
    // that leaks streams if it is not.
    useNode([CIRCUIT()]);
    const close = vi.fn(async () => {});
    connect.mockResolvedValue({ call: "duplex", close });
    fetchOverDuplex.mockRejectedValue(new Error("boom"));
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    await expect(peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"))).rejects.toThrow(
      "boom",
    );
    // Once per attempt, and there are two attempts (first call, then retry).
    expect(close).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// "`runOnLimitedConnection` IS EVERYWHERE FOR ONE REASON. A raw circuit is a
// 'limited' connection … and libp2p refuses custom protocols on one unless
// BOTH ENDS opt in." — mesh.ts module comment.
// SYMMETRIC PAIR, and the record names it as one: both ends.
// ---------------------------------------------------------------------------

describe("runOnLimitedConnection, on both ends", () => {
  it("the SERVING end opts in", async () => {
    useNode([CIRCUIT()]);
    await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    expect(serveConnections.mock.calls[0]?.[0]).toMatchObject({ runOnLimitedConnection: true });
  });

  it("the DIALLING end opts in", async () => {
    useNode([CIRCUIT()]);
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(connect.mock.calls[0]?.[0]).toMatchObject({ runOnLimitedConnection: true });
  });

  it("the retry's dial opts in as well", async () => {
    // The third place it has to be, and the easiest to forget: a retry that
    // dropped the flag would fail on exactly the connections the retry exists
    // to replace.
    useNode([CIRCUIT()]);
    let attempt = 0;
    connect.mockImplementation(async () => {
      attempt++;
      if (attempt === 1) throw new Error("timeout");
      return { call: "duplex", close: vi.fn(async () => {}) };
    });
    const peer = await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    await peer.fetch(HUB_ADDRESS(), new Request("http://hub/hello"));
    expect(connect.mock.calls.at(-1)?.[0]).toMatchObject({ runOnLimitedConnection: true });
  });
});

// ---------------------------------------------------------------------------
// "One handler per inbound stream, with the proven peer id captured in the
// closure. `Duplex` carries bytes and nothing else, so identity cannot ride
// along inside it … it is why a forged header cannot impersonate anyone."
// — mesh.ts. Note 08 §2 names this as the seam note 24 concluded was needed.
// ---------------------------------------------------------------------------

describe("identity reaches the handler by closure", () => {
  it("the per-stream handler is given the connection's proven remotePeer", async () => {
    useNode([CIRCUIT()]);
    const seen: string[] = [];
    await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: async (_req, callerPeerId) => {
        seen.push(callerPeerId);
        return new Response("ok");
      },
    });

    // `serveConnections(init, makeHandler)` — call the factory the way the
    // library does, once per inbound stream, and run what it builds.
    const makeHandler = serveConnections.mock.calls[0]?.[1] as (ctx: {
      remotePeer: PeerId;
    }) => unknown;
    makeHandler({ remotePeer: HUB });
    const fetchHandler = serveFetchOverDuplex.mock.calls.at(-1)?.[0] as (
      r: Request,
    ) => Promise<Response>;
    await fetchHandler(new Request("http://me/x"));

    expect(seen).toEqual([HUB.toString()]);
  });

  it("two streams from different peers get their own identity, not the last one seen", async () => {
    // The closure claim at its actual strength. A handler built once and
    // shared — or one reading a module-level variable — would give both
    // streams the same caller, and the impersonation the comment rules out
    // would be back by a different route.
    useNode([CIRCUIT()]);
    const seen: string[] = [];
    await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: async (_req, callerPeerId) => {
        seen.push(callerPeerId);
        return new Response("ok");
      },
    });
    const makeHandler = serveConnections.mock.calls[0]?.[1] as (ctx: {
      remotePeer: PeerId;
    }) => unknown;
    const other = await newPeerId();

    makeHandler({ remotePeer: HUB });
    const first = serveFetchOverDuplex.mock.calls.at(-1)?.[0] as (r: Request) => Promise<Response>;
    makeHandler({ remotePeer: other });
    const second = serveFetchOverDuplex.mock.calls.at(-1)?.[0] as (r: Request) => Promise<Response>;

    // Interleaved deliberately: the second stream is built before the first
    // one's request is served, which is what a shared variable would get wrong.
    await first(new Request("http://me/x"));
    await second(new Request("http://me/y"));

    expect(seen).toEqual([HUB.toString(), other.toString()]);
  });
});

// ---------------------------------------------------------------------------
// The node's own construction. Stated in the module comment as the reason a
// browser peer works at all.
// ---------------------------------------------------------------------------

describe("how the node is built", () => {
  it("listens on /p2p-circuit, because a tab has no listening socket", async () => {
    useNode([CIRCUIT()]);
    await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    expect(createLibp2p.mock.calls[0]?.[0]).toMatchObject({
      addresses: { listen: ["/p2p-circuit"] },
    });
  });

  it("appends circuitRelayTransport to whatever the caller supplied, and keeps the caller's first", async () => {
    // The isomorphism seam: the caller's list is the ONLY thing that differs
    // between the browser and Node harnesses, so it must arrive intact.
    useNode([CIRCUIT()]);
    const a = Symbol("webSockets");
    const b = Symbol("webRTC");
    await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [a, b],
      handler: noopHandler,
    });
    const cfg = createLibp2p.mock.calls[0]?.[0] as { transports: unknown[] } | undefined;
    const transports = cfg?.transports ?? [];
    expect(transports.slice(0, 2)).toEqual([a, b]);
    expect(transports).toHaveLength(3);
  });

  it("does not deny private multiaddrs, so a local relay is dialable", async () => {
    // "Without this, libp2p's default gater refuses private addresses, which
    // is exactly what a local relay is during development" — i.e. the whole
    // Node harness.
    useNode([CIRCUIT()]);
    await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    const cfg = createLibp2p.mock.calls[0]?.[0] as {
      connectionGater: { denyDialMultiaddr: () => Promise<boolean> };
    };
    await expect(cfg.connectionGater.denyDialMultiaddr()).resolves.toBe(false);
  });

  it("serves BEFORE reserving, so no inbound stream can arrive unhandled", async () => {
    // Ordering worth pinning: the reservation is what makes this peer
    // reachable, so registering the handler afterwards would leave a window in
    // which a dial succeeds and nothing answers.
    const node = useNode([CIRCUIT()]);
    const order: string[] = [];
    serveConnections.mockImplementation(async () => {
      order.push("serve");
    });
    const realDial = node.dial;
    node.dial = async (ma) => {
      order.push("dial");
      return realDial(ma);
    };
    await startPeer({
      relay: `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`,
      transports: [],
      handler: noopHandler,
    });
    expect(order).toEqual(["serve", "dial"]);
  });

  it("exposes the peer id, the resolved relay addresses, and a stop that stops the node", async () => {
    const node = useNode([CIRCUIT()]);
    const relayAddr = `/ip4/1.2.3.4/tcp/443/ws/p2p/${RELAY}`;
    const peer = await startPeer({ relay: relayAddr, transports: [], handler: noopHandler });
    expect(peer.peerId).toBe(SELF.toString());
    expect(peer.relayAddrs).toEqual([relayAddr]);
    expect(peer.node).toBe(node);
    await peer.stop();
    expect(node.stopped).toBe(true);
  });
});

describe("json()", () => {
  it("defaults to 200 and sets a JSON content type", async () => {
    const res = json({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("carries the status it is given", async () => {
    expect(json({ error: "nope" }, 403).status).toBe(403);
  });
});
