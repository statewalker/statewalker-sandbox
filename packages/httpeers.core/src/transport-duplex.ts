/**
 * The transport adapter. THE ONLY FILE IN THIS PACKAGE THAT IMPORTS libp2p —
 * verify with `grep -rlE "^import.*libp2p" src/` from the package root; it
 * must list only this file. That constraint is what keeps the transport
 * swappable: everything else in `httpeers.core` talks `FetchHandler`
 * (`Request -> Promise<Response>`) and never sees a `Stream` or a
 * `Connection`.
 *
 * IDENTITY BY CLOSURE (note 24). `Duplex = (input) => AsyncGenerator` is one
 * parameter, deliberately, with no slot for identity — hiding the transport
 * is what makes `Duplex` swappable. So the serving-side `Duplex` is built PER
 * INBOUND STREAM, with the proven peer captured in that build's closure, and
 * `registerPeer` runs from inside it before `dispatch` ever sees the
 * `Request`. `serveConnections` (from `@statewalker/webrun-streams-libp2p`)
 * exists for exactly this: it calls back once per stream with a
 * `ConnectionContext` carrying `remotePeer` — the peer id libp2p's Noise
 * handshake proved for that connection, the one identity claim on the
 * serving side nothing in the request payload can forge.
 *
 * `serveConnections` is used here rather than registering the protocol by
 * hand (`node.handle`), because it already threads `ConnectionContext`
 * through and owns the serving-side input queue / backpressure handling
 * (`duplexOverStream`) a hand port would have to reimplement.
 */
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
// Re-exported so `peer.ts` (and any other consumer) can type an already-
// constructed node, or a retained signing key, without itself importing
// `@libp2p/interface` — this file stays the only one that does.
export type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect, type ConnectionContext, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { createLibp2p } from "libp2p";
import { registerPeer } from "./peer-context.js";
import type { FetchHandler, PeerIdStr, Remote } from "./types.js";

/**
 * A namespaced protocol id, passed explicitly rather than left at
 * `webrun-streams-libp2p`'s package default (`/webrun-streams/1.0.0`). The
 * protocol id is the demux key libp2p uses to route an inbound stream to a
 * handler on the node: sharing the generic default would collide with any
 * other `webrun-streams` consumer sharing the same libp2p node.
 */
export const PROTOCOL = "/httpeers/1.0.0";

/**
 * Per-connection concurrent stream cap, applied to both directions. libp2p's
 * own default is 32 inbound / 64 outbound streams per protocol per
 * connection; past the inbound default, a new stream is RESET rather than
 * queued (ledger note 18), so a caller that opens one stream per in-flight
 * request starts seeing its 33rd concurrent request fail with no way to
 * recover it. 512 is the recorded precedent from the stream-limits task
 * (6a) and its regression tests in `webrun-streams-libp2p`.
 */
export const DEFAULT_MAX_STREAMS = 512;

/**
 * How long a served stream waits for a backpressured peer to drain before
 * being dropped. This is the ONLY bound on a peer that requests something
 * and then stops reading without closing — the serving side has no
 * `.return`/abort escape the way `connect`'s caller side does.
 *
 * It multiplies with `DEFAULT_MAX_STREAMS`: a peer that opens the full
 * stream cap and never reads any of them pins `DEFAULT_MAX_STREAMS *
 * drainTimeoutMs` stream-milliseconds of server-side buffer before every one
 * of them is finally dropped. `webrun-streams-libp2p`'s own default (5
 * minutes) times a 512-stream cap is ~42.7 stream-hours of exposure — too
 * generous to leave in force once the cap itself has been raised well past
 * libp2p's default. 15 seconds is chosen instead: long enough that a
 * legitimate reader on a slow or lossy link still has room to drain a
 * response chunk (multiple seconds of headroom even at very low bandwidth),
 * short enough that the worst case — every one of 512 streams held open by a
 * peer that never reads — caps out at 512 * 15s ≈ 2.1 stream-hours and clears
 * within one operational window rather than requiring intervention.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

export interface CreateNodeInit {
  /**
   * Multiaddrs to listen on. Omit (or pass an empty array) for a dial-only
   * node — one that can call out but accepts no inbound connections, which
   * is a legitimate deployment shape (a client-only edge peer).
   */
  listen?: string[];
  /**
   * The node's own signing key. Omit to let libp2p generate one internally
   * — fine for a peer that never needs to prove that key again once the
   * node exists. `createPeer` generates and RETAINS this key itself (never
   * here) when it needs to mint tokens later, because `createLibp2p` never
   * hands a generated key back out; if the caller doesn't keep the
   * reference before calling this function, it is gone for good.
   */
  privateKey?: Ed25519PrivateKey;
}

/**
 * Build a libp2p node with the transport stack this package's tests and
 * `createPeer`'s default construction path both rely on: TCP, Noise
 * (connection encryption — this is what makes `ConnectionContext.remotePeer`
 * trustworthy), Yamux (stream muxing) and identify (address exchange, so a
 * peer dialled once by full multiaddr can be dialled again by bare peerId —
 * see `createRemote`). Not the only file allowed to build a node makes this
 * package's swappable-transport claim false, so this stays inside
 * `transport-duplex.ts`; `peer.ts` calls it, never `createLibp2p` directly.
 */
export async function createNode(init: CreateNodeInit = {}): Promise<Libp2p> {
  const { listen = [], privateKey } = init;
  return createLibp2p({
    ...(privateKey != null ? { privateKey } : {}),
    addresses: { listen },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

export interface ServeTransportInit {
  node: Libp2p;
  /** The composed peer router — everything downstream of identity. */
  dispatch: FetchHandler;
  /** Defaults to `PROTOCOL`. */
  protocol?: string;
  /** Defaults to `DEFAULT_DRAIN_TIMEOUT_MS`. See that constant's doc comment. */
  drainTimeoutMs?: number;
  /** Defaults to `DEFAULT_MAX_STREAMS`. See that constant's doc comment. */
  maxInboundStreams?: number;
  /** Defaults to `DEFAULT_MAX_STREAMS`. See that constant's doc comment. */
  maxOutboundStreams?: number;
}

/**
 * Register the httpeers protocol handler on `node`. Every inbound stream
 * gets its own `Duplex`, closing over that stream's proven `remotePeer` —
 * `registerPeer` runs before `dispatch` is ever called, so every handler
 * downstream (the binding middleware first) sees the identity the transport
 * itself proved, never anything the peer merely claims.
 *
 * Returns the teardown function `serveConnections` itself returns
 * (`node.unhandle` for this protocol).
 */
export async function serveTransport(init: ServeTransportInit): Promise<() => Promise<void>> {
  const {
    node,
    dispatch,
    protocol = PROTOCOL,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    maxInboundStreams = DEFAULT_MAX_STREAMS,
    maxOutboundStreams = DEFAULT_MAX_STREAMS,
  } = init;
  return serveConnections(
    { node, protocol, drainTimeoutMs, maxInboundStreams, maxOutboundStreams },
    (context: ConnectionContext) => {
      const peerId = context.remotePeer.toString();
      return serveFetchOverDuplex(async (req) => {
        registerPeer(req, peerId);
        return dispatch(req);
      });
    },
  );
}

export interface CreateRemoteInit {
  node: Libp2p;
  /** Defaults to `PROTOCOL`. */
  protocol?: string;
  /** Defaults to `DEFAULT_DRAIN_TIMEOUT_MS`. See that constant's doc comment. */
  drainTimeoutMs?: number;
  /**
   * Defaults to `DEFAULT_MAX_STREAMS`. Set here too, not only on the serving
   * side: a peer both serves and dials (a relay forwards by dialing out), so
   * the outbound cap needs the same headroom as the inbound one.
   */
  maxOutboundStreams?: number;
}

/**
 * Build the `Remote` seam `createPeerRouter` forwards through: dial `target`
 * over libp2p and run the request over the resulting `Duplex`. Outbound is
 * definitionally identity-free — nothing here registers a peer binding,
 * because the *caller's* proven identity has no meaning on a connection *we*
 * initiated.
 */
export function createRemote(init: CreateRemoteInit): Remote {
  const {
    node,
    protocol = PROTOCOL,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    maxOutboundStreams = DEFAULT_MAX_STREAMS,
  } = init;
  return async (target: PeerIdStr, req: Request): Promise<Response> => {
    const { call } = await connect({
      node,
      peer: multiaddr(`/p2p/${target}`),
      protocol,
      drainTimeoutMs,
      maxOutboundStreams,
    });
    return fetchOverDuplex(call, req);
  };
}
