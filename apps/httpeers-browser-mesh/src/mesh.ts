/**
 * A peer, and the two things a peer does: serve HTTP to the mesh, and fetch
 * HTTP from it.
 *
 * ISOMORPHIC ON PURPOSE. Nothing below branches on browser vs Node except
 * the transport list, which the caller supplies. That is what lets the same
 * hub and the same resources be exercised by `tests/node-verify.mjs` (two
 * Node peers, a local relay) and by `tests/browser.spec.ts` (two tabs, the
 * public relay) without a second implementation to keep in step. When the
 * browser test fails and the Node one passes, the difference is the
 * browser — not the logic.
 *
 * WHY A BROWSER PEER NEEDS THE RELAY AT ALL. A tab has no listening socket,
 * so it cannot be dialled. It reserves a slot on the relay and becomes
 * reachable at `<relayAddr>/p2p-circuit/webrtc/p2p/<peerId>`. The relay
 * carries the WebRTC signalling; ICE then makes the connection direct and
 * the relay leaves the data path. It stays in the path only when ICE fails.
 *
 * `runOnLimitedConnection` IS EVERYWHERE FOR ONE REASON. A raw circuit is a
 * "limited" connection — the relay caps its bytes and its duration — and
 * libp2p refuses custom protocols on one unless BOTH ends opt in. A
 * `/webrtc` upgrade produces an unlimited connection and would not need
 * this, but the opt-in has to be in place for the pre-upgrade window and
 * for the ICE-failed fallback, and it costs nothing when the upgrade
 * succeeds.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Libp2p } from "@libp2p/interface";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import type { Multiaddr } from "@multiformats/multiaddr";
import { multiaddr } from "@multiformats/multiaddr";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { createLibp2p } from "libp2p";
import { resolveRelayAddrs } from "./relay-discovery.js";

/** A request handler that also knows who libp2p proved is calling. */
export type PeerHandler = (request: Request, callerPeerId: string) => Promise<Response>;

export interface Peer {
  node: Libp2p;
  peerId: string;
  /** This peer's dialable address through the relay, `/p2p/<self>` included. */
  address: string;
  /** The relay addresses this peer resolved and dialled. */
  relayAddrs: string[];
  /** Call another peer, addressed by its full multiaddr. */
  fetch: (address: string, request: Request) => Promise<Response>;
  stop: () => Promise<void>;
}

export interface StartPeerInit {
  /**
   * Either the relay's URL (`https://relay.httpeers.net`) or a multiaddr
   * (`/ip4/127.0.0.1/tcp/9590/ws/p2p/12D3Koo…`).
   *
   * The URL form is preferred and is what a real deployment uses: the relay
   * publishes its addresses — peer id included — at
   * `/.well-known/httpeers-relay.json`, so nothing has to be copied out of a
   * deployment log. The multiaddr form is for local development, where the
   * relay is a bare process with no document in front of it.
   */
  relay: string;
  /** Transports. The browser adds `webRTC()`; Node does not. */
  transports: unknown[];
  /** Serves every inbound request. */
  handler: PeerHandler;
  /** How long to wait for a circuit reservation. */
  reservationTimeoutMs?: number;
}

export async function startPeer(init: StartPeerInit): Promise<Peer> {
  const node = await createLibp2p({
    addresses: { listen: ["/p2p-circuit"] },
    // biome-ignore lint/suspicious/noExplicitAny: transports are supplied by the caller so this module stays environment-free.
    transports: [...(init.transports as any[]), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
    connectionGater: {
      // Browser peers on a public relay talk to whoever the relay puts them
      // in touch with. Without this, libp2p's default gater refuses private
      // addresses, which is exactly what a local relay is during
      // development.
      denyDialMultiaddr: async () => false,
    },
  });

  await serveConnections(
    { node, runOnLimitedConnection: true },
    ({ remotePeer }) =>
      // One handler per inbound stream, with the proven peer id captured in
      // the closure. `Duplex` carries bytes and nothing else, so identity
      // cannot ride along inside it — this is how it reaches the handler
      // without either library growing a parameter, and it is why a forged
      // header cannot impersonate anyone.
      serveFetchOverDuplex((request) => init.handler(request, remotePeer.toString())),
  );

  const relayAddrs = await resolveRelayAddrs(init.relay);
  await dialAnyRelay(node, relayAddrs);

  const address = await waitForCircuitAddress(node, init.reservationTimeoutMs ?? 30_000);

  return {
    node,
    peerId: node.peerId.toString(),
    address,
    relayAddrs,
    async fetch(target: string, request: Request): Promise<Response> {
      // ADDRESS FOR FIRST CONTACT, PEER ID AFTERWARDS.
      //
      // Dialling a circuit multiaddr always asks the relay for a NEW hop,
      // even when a connection to that peer is already open. Two peers that
      // call each other therefore accumulate circuits, and the second one
      // times out during the Noise handshake — an `EncryptionFailedError`
      // that names encryption and has nothing to do with it.
      //
      // Passing the peer id instead lets libp2p reuse the connection it
      // already holds, in either direction: a peer that was dialled can
      // call back over the same circuit. So: resolve the address to a peer
      // id, and only fall back to the full multiaddr when nothing is
      // connected yet.
      //
      // RETRY ONCE, ALWAYS. A relayed connection is not durable: the relay
      // caps its duration (five minutes on the deployed relay) and closes
      // it when the budget runs out, so any long-lived client must be able
      // to re-dial. There is also an unexplained ceiling — see README,
      // "the five-call ceiling" — where a reused raw circuit stops
      // accepting new streams well before its advertised limits are spent.
      // Both surface the same way: a dial that times out during the Noise
      // handshake, reported as `EncryptionFailedError`.
      try {
        return await callOnce(reusablePeer(node, target) ?? multiaddr(target));
      } catch {
        // Drop whatever we were holding and dial the address afresh.
        for (const connection of node.getConnections()) {
          if (connection.limits != null) await connection.close();
        }
        return await callOnce(multiaddr(target));
      }

      async function callOnce(peer: PeerId | Multiaddr): Promise<Response> {
        const { call, close } = await connect({ node, peer, runOnLimitedConnection: true });
        try {
          const response = await fetchOverDuplex(call, request);
          // Buffer the body before releasing the transport: `close()` tears
          // down the streams this call owns, and a streamed body still being
          // read from one of them would be truncated.
          return new Response(await response.arrayBuffer(), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } finally {
          // `connect()` owns the streams it opens and hands back a `close()`
          // to release them. Releasing them is correct hygiene — but note
          // that it does NOT fix the five-call ceiling: the ceiling was
          // reproduced both with and without this call, so the leaked
          // streams were never the cause.
          await close();
        }
      }
    },
    async stop() {
      await node.stop();
    },
  };
}

/**
 * Dials the published relay addresses in order, succeeding on the first.
 *
 * The document may list several — a relay with both an IPv4 and an IPv6
 * address, say — and a peer on a network without one of them must not be
 * stopped by it. Failing only after all of them have failed, and reporting
 * every error, is the difference between "the relay is unreachable" and "the
 * first address in a list of three did not work".
 */
async function dialAnyRelay(node: Libp2p, relayAddrs: string[]): Promise<void> {
  const failures: string[] = [];
  for (const addr of relayAddrs) {
    try {
      await node.dial(multiaddr(addr));
      return;
    } catch (err) {
      failures.push(`${addr}: ${(err as Error).message}`);
    }
  }
  throw new Error(`could not dial the relay at any published address:\n  ${failures.join("\n  ")}`);
}

/**
 * The peer id at the end of a multiaddr, when this node already has a
 * connection to it. `null` when the address names no peer, names one we
 * have never met, or is malformed — every case meaning "dial the address".
 */
function reusablePeer(node: Libp2p, address: string) {
  const match = /\/p2p\/([^/]+)$/.exec(address);
  if (match?.[1] == null) return null;
  try {
    const peerId = peerIdFromString(match[1]);
    return node.getConnections(peerId).length > 0 ? peerId : null;
  } catch {
    return null;
  }
}

/**
 * Waits for the relay to grant a reservation and returns the resulting
 * address.
 *
 * Prefers a `/webrtc` address when one appears: that is the one another
 * browser peer should dial, because dialling it upgrades the connection off
 * the relay. Falls back to the plain circuit address, which is what a Node
 * peer without the WebRTC transport gets and what everyone gets when the
 * upgrade is unavailable.
 */
async function waitForCircuitAddress(node: Libp2p, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const addrs = node.getMultiaddrs().map(String);
    const webrtc = addrs.find((a) => a.includes("/p2p-circuit/webrtc/"));
    const circuit = addrs.find((a) => a.includes("/p2p-circuit"));
    const chosen = webrtc ?? circuit;
    if (chosen != null) return chosen;
    if (Date.now() > deadline) {
      throw new Error(
        "no circuit reservation within timeout — the relay is unreachable, or it is " +
          "advertising an address that is not the one you dialled",
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** JSON response helper — every endpoint in this test speaks JSON. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
