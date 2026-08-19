/**
 * Task 6b: `createPeer` assembled over a real libp2p transport — two real
 * nodes, loopback TCP, no mocks.
 *
 * Re-derives D6/D7/D8 from the (unpromotable) validated prototype at
 * `notes/.../26-duplex-identity-prototype-validated/duplex-identity.test.ts`
 * against the SHIPPED API (`serveConnections`/`connect` from
 * `@statewalker/webrun-streams-libp2p`, `fetchOverDuplex` from
 * `@statewalker/webrun-http-streams`), not that prototype's `vendor/` copies,
 * and drives them through the assembled peer (`createPeer`) rather than a
 * bespoke `httpOverLibp2p` helper — so this also proves the composition
 * itself, not just the transport underneath it.
 *
 * The full node<->node integration suite (headers, query strings, streaming
 * bodies, 40-concurrent, bodiless statuses, non-ASCII) is Task 6c's promoted
 * `tests/integration.test.ts`; this file's job is identity, and identity
 * only.
 */
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "@statewalker/webrun-streams-libp2p";
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { DEFAULT_ACCESS_TREE } from "../src/access-tree.js";
import { lookupPeer } from "../src/peer-context.js";
import { createPeer, type Peer } from "../src/peer.js";
import { createMounts } from "../src/router.js";
import { mintToken, verifyToken } from "../src/tokens.js";
import { ANONYMOUS, json } from "../src/types.js";
import { DEFAULT_MAX_STREAMS, PROTOCOL } from "../src/transport-duplex.js";
import { DEFAULT_VOCABULARY } from "../src/vocabulary.js";

async function node(listen: boolean): Promise<Libp2p> {
  return createLibp2p({
    addresses: listen ? { listen: ["/ip4/127.0.0.1/tcp/0"] } : {},
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

/** The mounted test handler: echoes back what the transport proved. */
function whoamiHandler() {
  return async (req: Request): Promise<Response> => {
    const peer = lookupPeer(req);
    return json({ peer: peer === ANONYMOUS ? null : peer });
  };
}

/** A raw libp2p caller, bypassing `createPeer` entirely on the calling side —
 * this is what proves identity is established by the TRANSPORT, not by
 * anything a well-behaved `createPeer` client would have sent anyway. */
async function call(client: Libp2p, serverAddr: Multiaddr, req: Request): Promise<Response> {
  const { call: duplex } = await connect({
    node: client,
    peer: serverAddr,
    protocol: PROTOCOL,
    maxOutboundStreams: DEFAULT_MAX_STREAMS,
  });
  return fetchOverDuplex(duplex, req);
}

async function whoami(client: Libp2p, serverAddr: Multiaddr, headers?: HeadersInit): Promise<string | null> {
  const res = await call(client, serverAddr, new Request("http://peer/test/whoami", { headers }));
  const body = (await res.json()) as { peer: string | null };
  return body.peer;
}

describe("createPeer: identity by closure over the shipped transport", () => {
  let server: Libp2p;
  let serverPeer: Peer;
  let serverAddr: Multiaddr;
  let clientA: Libp2p;
  let hubKey: Ed25519PrivateKey;
  let hubPeerId: string;

  beforeEach(async () => {
    hubKey = await generateKeyPair("Ed25519");
    hubPeerId = peerIdFromPrivateKey(hubKey).toString();

    server = await node(true);
    const mounts = createMounts();
    mounts.provide("/test", whoamiHandler());
    serverPeer = await createPeer({
      node: server,
      selfPeerId: server.peerId.toString(),
      mounts,
      accessTree: DEFAULT_ACCESS_TREE,
      vocabulary: DEFAULT_VOCABULARY,
      hubPeerId,
    });
    const addr = server.getMultiaddrs()[0];
    if (addr == null) throw new Error("server has no listen address");
    serverAddr = addr;

    clientA = await node(false);
  }, 20_000);

  afterEach(async () => {
    await Promise.allSettled([serverPeer?.stop(), server?.stop(), clientA?.stop()]);
  });

  async function tokenFor(sub: string, roles = ["member"]): Promise<string> {
    return mintToken({ privateKey: hubKey, sub, roles, ttlMs: 60_000 });
  }

  // --- composition: valid token in, mismatched sub out ----------------------

  it("a request with a valid token reaches the mounted handler", async () => {
    const clientId = clientA.peerId.toString();
    const token = await tokenFor(clientId);
    const res = await call(
      clientA,
      serverAddr,
      new Request("http://peer/test/whoami", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { peer: string | null };
    expect(body.peer).toBe(clientId);
  }, 20_000);

  it("a token whose sub names a different peer than the connection proved is refused with 403", async () => {
    const token = await tokenFor("12D3KooWNotTheCallerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    const res = await call(
      clientA,
      serverAddr,
      new Request("http://peer/test/whoami", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(403);
  }, 20_000);

  // --- D6: two distinct clients, no cross-talk -------------------------------

  it("D6: two clients get two distinct identities, with no cross-talk between concurrent connections", async () => {
    const clientB = await node(false);
    try {
      const idA = clientA.peerId.toString();
      const idB = clientB.peerId.toString();
      const tokenA = await tokenFor(idA);
      const tokenB = await tokenFor(idB);

      const [peerSeenForA, peerSeenForB] = await Promise.all([
        whoami(clientA, serverAddr, { authorization: `Bearer ${tokenA}` }),
        whoami(clientB, serverAddr, { authorization: `Bearer ${tokenB}` }),
      ]);

      expect(peerSeenForA).toBe(idA);
      expect(peerSeenForB).toBe(idB);
      expect(peerSeenForA).not.toBe(peerSeenForB);
    } finally {
      await clientB.stop();
    }
  }, 20_000);

  // --- D7: a caller-supplied header cannot forge the proven peer ------------

  it("D7: a caller-supplied x-httpeers-peer header cannot forge the proven peer", async () => {
    const clientId = clientA.peerId.toString();
    const token = await tokenFor(clientId);
    const seen = await whoami(clientA, serverAddr, {
      authorization: `Bearer ${token}`,
      "x-httpeers-peer": "12D3KooWForgedXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
    expect(seen).toBe(clientId);
    expect(seen).not.toBe("12D3KooWForgedXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
  }, 20_000);

  // --- D8: concurrency doesn't cross-wire identity ---------------------------

  it("D8: 20 concurrent requests each carry the correct identity", async () => {
    const clientId = clientA.peerId.toString();
    const token = await tokenFor(clientId);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => whoami(clientA, serverAddr, { authorization: `Bearer ${token}` })),
    );
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(clientId);
    expect(results).toHaveLength(20);
  }, 30_000);

  // --- privateKey retention: a supplied key becomes the peer's real identity

  it("a supplied privateKey becomes the peer's actual identity, mintable and verifiable against it", async () => {
    const key = await generateKeyPair("Ed25519");
    const expectedPeerId = peerIdFromPrivateKey(key).toString();

    // No `node` supplied -- exercises createPeer's own self-built-node path,
    // where `privateKey` is threaded to `createNode` rather than generated
    // (and lost) inside it.
    const hubLikePeer = await createPeer({ privateKey: key, listen: ["/ip4/127.0.0.1/tcp/0"] });
    try {
      expect(hubLikePeer.peerId).toBe(expectedPeerId);
      expect(hubLikePeer.libp2p.peerId.toString()).toBe(expectedPeerId);

      // Mint with the SAME key the caller supplied, then verify against the
      // peer's own reported peerId as issuer -- proving the key `createPeer`
      // built its node with is the exact key still available to sign with,
      // not a different one generated and discarded somewhere in between.
      const token = await mintToken({
        privateKey: key,
        sub: "12D3KooWSomeMemberXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        roles: ["member"],
        ttlMs: 60_000,
      });
      const claims = await verifyToken(token, { issuer: hubLikePeer.peerId });
      expect(claims.mesh).toBe(hubLikePeer.peerId);
      expect(claims.iss).toBe(hubLikePeer.peerId);
      expect(claims.sub).toBe("12D3KooWSomeMemberXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    } finally {
      await hubLikePeer.stop();
    }
  }, 20_000);

  // --- accessTree/vocabulary: default together, or not at all ---------------

  it("throws when accessTree is supplied without vocabulary", async () => {
    await expect(createPeer({ node: clientA, accessTree: DEFAULT_ACCESS_TREE })).rejects.toThrow(
      /accessTree and vocabulary must be supplied together/,
    );
  });

  it("throws when vocabulary is supplied without accessTree", async () => {
    await expect(createPeer({ node: clientA, vocabulary: DEFAULT_VOCABULARY })).rejects.toThrow(
      /accessTree and vocabulary must be supplied together/,
    );
  });

  it("defaults mounts/accessTree/vocabulary together when none are supplied, and the default /test/whoami mount answers", async () => {
    const freshServer = await node(true);
    let defaultsPeer: Peer | undefined;
    try {
      // No mounts/accessTree/vocabulary at all -- exercises defaultMounts()
      // and the DEFAULT_ACCESS_TREE/DEFAULT_VOCABULARY pair together.
      defaultsPeer = await createPeer({ node: freshServer, hubPeerId });
      const addr = freshServer.getMultiaddrs()[0];
      if (addr == null) throw new Error("fresh server has no listen address");

      const clientId = clientA.peerId.toString();
      const token = await tokenFor(clientId);
      const seen = await whoami(clientA, addr, { authorization: `Bearer ${token}` });
      expect(seen).toBe(clientId);
    } finally {
      await Promise.allSettled([defaultsPeer?.stop(), freshServer.stop()]);
    }
  }, 20_000);
});
