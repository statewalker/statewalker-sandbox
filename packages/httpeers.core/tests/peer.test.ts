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

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { tcp } from "@libp2p/tcp";
import type { Multiaddr } from "@multiformats/multiaddr";
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect } from "@statewalker/webrun-streams-libp2p";
import { createLibp2p } from "libp2p";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPeer, type MountsFactoryContext, type Peer } from "../src/peer.js";
import { lookupPeer } from "../src/peer-context.js";
import { createMounts } from "../src/router.js";
import { DEFAULT_RULES } from "../src/rules.js";
import { mintToken, verifyToken } from "../src/tokens.js";
import { DEFAULT_MAX_STREAMS, PROTOCOL } from "../src/transport-duplex.js";
import { ANONYMOUS, json } from "../src/types.js";

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

async function whoami(
  client: Libp2p,
  serverAddr: Multiaddr,
  headers?: HeadersInit,
): Promise<string | null> {
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
      rules: DEFAULT_RULES,
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

  async function tokenFor(
    sub: string,
    roles = ["member"],
    audience?: readonly string[],
  ): Promise<string> {
    return mintToken({
      privateKey: hubKey,
      sub,
      roles,
      ttlMs: 60_000,
      ...(audience && { audience }),
    });
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

  it("a token whose sub names a different peer than the connection proved is refused", async () => {
    const token = await tokenFor("12D3KooWNotTheCallerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    const res = await call(
      clientA,
      serverAddr,
      new Request("http://peer/test/whoami", { headers: { authorization: `Bearer ${token}` } }),
    );
    // STILL 401, and now it says why. Task 29 moved this from 403 to 401
    // because ADR-0009's rule had moved inside the token (`check if bound($k),
    // connection_peer($k)`), so a mismatch failed VERIFICATION and `getClaims`
    // -- which swallowed every failure into `null` -- could only report "no
    // claims". Task 34 widened that seam: the status is the same, but the
    // refusal now keeps its own identity all the way to the response, so this
    // is no longer indistinguishable from presenting no token at all.
    //
    // 401 is a decision and not inertia. The confused-deputy replay is what
    // makes this check worth having, but it is not the only thing that reaches
    // it: a page that resets its identity while holding a token minted for its
    // old key lands here too, and for that client a refresh is the whole fix.
    // Telling it to stop would be a real failure; a thief looping on 401
    // obtains nothing, since retrying cannot produce a token bound to a key it
    // does not hold. The property under test is unchanged either way: a token
    // minted for somebody else does not work here.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "token subject does not match connected peer",
      reason: "peer-binding",
    });
    // ... and it is NOT the tokenless answer, which is the whole point of the
    // widening: same status, different refusal, and the body says which.
    const tokenless = await call(clientA, serverAddr, new Request("http://peer/test/whoami"));
    expect(tokenless.status).toBe(401);
    expect(await tokenless.json()).toEqual({ error: "membership token required" });
  }, 20_000);

  // --- A-24 / ADR-0020: the DESTINATION enforces the audience ---------------

  it("A-24: an audience-scoped token works at the peer it names", async () => {
    const clientId = clientA.peerId.toString();
    const token = await tokenFor(clientId, ["member"], [serverPeer.peerId]);
    const res = await call(
      clientA,
      serverAddr,
      new Request("http://peer/test/whoami", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(200);
  }, 20_000);

  it("A-24: ... and the SAME peer refuses one scoped to somebody else", async () => {
    // Dialled STRAIGHT AT this server over a real Noise-authenticated
    // connection -- nothing forwarded, nothing relayed, no router in the way.
    // The refusal is therefore not a routing artefact: it is this peer
    // evaluating the token's audience against its own `self_peer` fact.
    const clientId = clientA.peerId.toString();
    const token = await tokenFor(clientId, ["member"], [
      "12D3KooWSomeOtherProviderXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    ]);
    const res = await call(
      clientA,
      serverAddr,
      new Request("http://peer/test/whoami", { headers: { authorization: `Bearer ${token}` } }),
    );
    // 403, and the reason arrives with it. Task 31 recorded this as 401 with
    // the note that the `audience` reason was carried on a
    // `TokenVerificationError` `getClaims` swallowed, observable only one
    // layer down in `tokens.test.ts`. Task 34 stopped the swallowing: the
    // reason reaches the client, and the status tells it not to retry --
    // which for THIS condition is the whole point, since a refreshed token is
    // scoped exactly the same way and would be refused identically.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "this peer is not an intended audience for this token",
      reason: "audience",
    });
  }, 20_000);

  it("A-24: a hub mints least privilege -- one token, usable at one named peer", async () => {
    // The seam an APPLICATION has: a mounts factory's `mintToken`, never the
    // signing key. Without `audience` here a hub could only mint tokens valid
    // at every peer in the mesh, whatever `tokens.ts` supported underneath.
    const clientId = clientA.peerId.toString();
    let mint: MountsFactoryContext["mintToken"] | undefined;
    const hubPeer = await createPeer({
      privateKey: hubKey,
      mounts: (ctx) => {
        mint = ctx.mintToken;
        return createMounts();
      },
    });
    try {
      expect(hubPeer.peerId).toBe(hubPeerId);
      if (mint == null) throw new Error("the mounts factory was never called");

      const here = await mint(clientId, ["member"], { audience: [serverPeer.peerId] });
      const elsewhere = await mint(clientId, ["member"], {
        audience: ["12D3KooWSomeOtherProviderXXXXXXXXXXXXXXXXXXXXXXXXXXX"],
      });

      const ok = await call(
        clientA,
        serverAddr,
        new Request("http://peer/test/whoami", { headers: { authorization: `Bearer ${here}` } }),
      );
      const refused = await call(
        clientA,
        serverAddr,
        new Request("http://peer/test/whoami", {
          headers: { authorization: `Bearer ${elsewhere}` },
        }),
      );

      expect(ok.status).toBe(200);
      // 403, not 401: see the A-24 refusal test above for why the audience
      // condition sits on the do-not-retry side of the line.
      expect(refused.status).toBe(403);
    } finally {
      await hubPeer.stop();
    }
  }, 30_000);

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
      Array.from({ length: 20 }, () =>
        whoami(clientA, serverAddr, { authorization: `Bearer ${token}` }),
      ),
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
      const claims = await verifyToken(token, {
        issuer: hubLikePeer.peerId,
        // The token binds to its subject, so verifying it means standing in for
        // the connection that subject would present it over.
        connectionPeer: "12D3KooWSomeMemberXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      });
      expect(claims.mesh).toBe(hubLikePeer.peerId);
      expect(claims.iss).toBe(hubLikePeer.peerId);
      expect(claims.sub).toBe("12D3KooWSomeMemberXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    } finally {
      await hubLikePeer.stop();
    }
  }, 20_000);

  // --- rules: one value, so there is no pair to mismatch --------------------

  it("refuses a `rules` value that ruleSet() never built -- an unvalidated policy is the silent permanent denial", async () => {
    // The brand on `RuleSet` is not decoration: an object literal skips every
    // check `ruleSet()` makes, and a rule set that was never validated is
    // indistinguishable at runtime from one that works.
    const forged = { version: 1, rules: [], policies: [] } as unknown as typeof DEFAULT_RULES;
    await expect(createPeer({ node: clientA, rules: forged })).rejects.toThrow(
      /must be built by ruleSet\(\)/,
    );
  });

  it("defaults mounts and rules when neither is supplied, and the default /test/whoami mount answers", async () => {
    const freshServer = await node(true);
    let defaultsPeer: Peer | undefined;
    try {
      // No mounts and no rules at all -- exercises defaultMounts() against
      // DEFAULT_RULES.
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
