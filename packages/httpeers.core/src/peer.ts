/**
 * Peer assembly: wires Tasks 1-5 onto the transport adapter to produce one
 * running peer.
 *
 * COMPOSITION ORDER IS LOAD-BEARING: transport -> registerPeer -> binding
 * middleware -> access policy -> router -> mounts.
 *
 *   access: (local) => newPeerHandlers({
 *     getPeerId, usesTransportIdentity, getClaims, isRevoked,
 *     handleEndpoints: withAccessTree({ tree, vocabulary, usesTransportIdentity })(local),
 *   })
 *
 * BINDING OUTSIDE, POLICY INSIDE. `withAccessTree`'s `lookupClaims` read only
 * works because the binding middleware calls `getClaims` first — which
 * caches via `cacheClaims` — before policy ever runs. Reverse the nesting
 * and policy reads an empty cache: every request would look tokenless to
 * `.access`, no matter what it actually carried.
 *
 * The router's *remote* branch constructs a brand-new `Request` before
 * forwarding, which is fine specifically because outbound is
 * identity-free by definition — nothing downstream of a forward reads a
 * peer binding. The binding middleware itself must sit where nothing above
 * it has re-created the `Request` (note 07 §4): `newPeerHandlers` runs
 * directly on the request `serveTransport`'s per-stream closure registered
 * the peer on, with nothing re-constructing it in between.
 *
 * MOUNTS MAY BE A FACTORY, NOT ONLY A VALUE. A hub mints tokens with the
 * signing key `createPeer` retains (see `privateKey` below); its endpoints
 * need that capability, but this package must never learn what a "hub" is —
 * that would make the library import the application. So `mounts` may be a
 * function `(ctx) => Mounts`, called once construction has a `privateKey`
 * and a `selfPeerId`, receiving only a scoped `mintToken(sub, roles, ttlMs?)`
 * closure — never the key itself. An application builds whatever endpoints
 * it needs against that one capability; `createPeer` stays hub-agnostic.
 */

import type { AccessTree } from "./access-tree.js";
import { DEFAULT_ACCESS_TREE, withAccessTree } from "./access-tree.js";
import { cacheClaims, lookupClaims, lookupPeer } from "./peer-context.js";
import { newPeerHandlers } from "./peer-handlers.js";
import type { RevocationCache } from "./revocation.js";
import { createMounts, createPeerRouter } from "./router.js";
import { generateMeshKey, mintToken, verifyToken } from "./tokens.js";
import type { Ed25519PrivateKey, Libp2p } from "./transport-duplex.js";
import { createNode, createRemote, PROTOCOL, serveTransport } from "./transport-duplex.js";
import type {
  FetchHandler,
  GetClaims,
  GetPeerId,
  MeshClaims,
  Mounts,
  PeerIdStr,
  ProvenPeer,
  Remote,
  UsesTransportIdentity,
} from "./types.js";
import { ANONYMOUS, json } from "./types.js";
import type { Vocabulary } from "./vocabulary.js";
import { DEFAULT_VOCABULARY } from "./vocabulary.js";

/**
 * Default token lifetime for `MountsFactoryContext.mintToken` when a caller
 * omits `ttlMs`. `mintToken` in `tokens.ts` requires it explicitly (a
 * security-sensitive primitive should never guess); this is the one default
 * an *application* built on top of it may reasonably want. No note or spec
 * fixes a number, so this is chosen for this package: an order of magnitude
 * above a 5-second heartbeat interval, enough slack for a few missed beats
 * before a member-minted token itself expires (independent of revocation,
 * which is enforced separately via the pulled version vector).
 */
export const DEFAULT_MINT_TTL_MS = 60_000;

/**
 * What a `mounts` factory receives: this peer's own `peerId`, and a
 * capability to mint membership tokens that self-certify against it — never
 * the signing key itself. See the module comment's "MOUNTS MAY BE A
 * FACTORY" note for why this exists instead of exposing `privateKey`
 * directly.
 */
export interface MountsFactoryContext {
  peerId: PeerIdStr;
  /** Defaults `ttlMs` to `DEFAULT_MINT_TTL_MS` when omitted. */
  mintToken: (sub: string, roles: string[], ttlMs?: number) => Promise<string>;
}

/**
 * The default mount when the caller supplies no `mounts` table of its own:
 * a diagnostic `/test/whoami` that echoes back what the transport and
 * binding proved for the request (the connected peer, and the token's
 * `sub` once verified). `DEFAULT_ACCESS_TREE`'s `/test/` entry (requires
 * `std:test`, which the `member` role in `DEFAULT_VOCABULARY` grants) is
 * what gates it — this is not a bypass of policy, it exercises it.
 */
function defaultMounts(): Mounts {
  const mounts = createMounts();
  mounts.provide("/test", async (req) => {
    const peer = lookupPeer(req);
    const claims = lookupClaims(req) ?? null;
    return json({ peer: peer === ANONYMOUS ? null : peer, sub: claims?.sub ?? null });
  });
  return mounts;
}

export interface CreatePeerInit {
  /**
   * An already-constructed, already-started libp2p node. Optional: when
   * omitted, `createPeer` builds one itself via `transport-duplex.ts`'s
   * `createNode` (the one file in this package allowed to touch libp2p),
   * listening on `listen` if given, dial-only otherwise. A caller-supplied
   * node is never stopped by `Peer.stop()` — that stays the supplier's
   * responsibility, matching a node this package did not create.
   */
  node?: Libp2p;
  /**
   * Multiaddrs for a self-constructed node to listen on. Ignored when
   * `node` is supplied. Omit for a dial-only peer that accepts no inbound
   * connections — a legitimate shape, e.g. an edge client.
   */
  listen?: string[];
  /**
   * This peer's own signing key, for a self-constructed node. Ignored when
   * `node` is supplied (that node's identity is already fixed). Omit to
   * have `createPeer` generate one and retain it — `createLibp2p` never
   * hands a generated key back out, so if nothing above it keeps the
   * reference before the node is built, it is gone for good, and this peer
   * could never later mint a token that self-certifies as its own peerId
   * (`mintToken`/`verifyToken`'s self-certification check in `tokens.ts`
   * ties a valid token's `mesh` to the actual signing key's peerId). Not
   * exposed on the returned `Peer` — retaining it here, for a later task's
   * minting logic to close over, is the point; publishing it is not.
   */
  privateKey?: Ed25519PrivateKey;
  /** Defaults to the node's own peerId (caller- or self-constructed). */
  selfPeerId?: PeerIdStr;
  /**
   * Defaults to a mount table with a single diagnostic `/test/whoami`
   * handler (see `defaultMounts`) — enough to prove routing, identity and
   * policy end to end without depending on an application's own endpoints.
   *
   * May be a plain `Mounts`, or a factory `(ctx: MountsFactoryContext) =>
   * Mounts` called once this peer's signing key and peerId are settled — the
   * shape an application that needs to mint tokens (e.g. a mesh's hub) must
   * use, since the key itself is never exposed. See `MountsFactoryContext`.
   */
  mounts?: Mounts | ((ctx: MountsFactoryContext) => Mounts);
  /**
   * Defaults to `DEFAULT_ACCESS_TREE`, but only paired with `vocabulary`
   * defaulting too — see `vocabulary` below.
   */
  accessTree?: AccessTree;
  /**
   * Defaults to `DEFAULT_VOCABULARY`, but ONLY when `accessTree` is also
   * omitted (and vice versa): `createPeer` throws at construction if
   * exactly one of `accessTree`/`vocabulary` is supplied. A custom
   * `accessTree` evaluated against the wrong vocabulary (or vice versa) is
   * the exact fail-open `withAccessTree`'s required `vocabulary` field was
   * introduced to rule out — a tree that validates fine, then evaluates
   * every request against a role→capability mapping the caller never
   * intended. Defaulting both together, as a matched pair, does not
   * reintroduce that; inheriting one while defaulting the other would.
   */
  vocabulary?: Vocabulary;
  /**
   * The mesh (hub) peerId membership tokens must self-certify against —
   * `verifyToken`'s `issuer` option. Defaults to `selfPeerId`: a peer that
   * names no other mesh trusts only tokens it minted itself — which is
   * exactly the mesh's own hub, with no separate flag needed to say so.
   */
  hubPeerId?: PeerIdStr;
  /**
   * Does a given request bootstrap identity from the transport handshake
   * alone, with no token expected yet? Defaults to "never" — Task 6 mounts
   * no bootstrap endpoints (`/.well-known/invite`, `/.well-known/presence`
   * are Task 7's). A peer that mounts its own hub endpoints must supply the
   * real predicate.
   */
  usesTransportIdentity?: UsesTransportIdentity;
  /**
   * Pulled-and-cached revocation list (`RevocationCache` from
   * `revocation.ts`). Optional — omit and nothing is ever revoked.
   * `RevocationCache.check` is deliberately synchronous (a pure in-memory
   * lookup); this is the wrap-at-the-call-site the binding's `isRevoked`
   * seam (which is `async`) was left for.
   */
  revocationCache?: RevocationCache;
  /**
   * May this peer relay on behalf of others? Deny by default (R-2):
   * relaying is a distinct capability, not a side effect of knowing how to
   * route. A request that originated locally (no proven peer — our own
   * edge) may always be forwarded; a request that arrived from the network
   * (a proven peer) may be forwarded only when this flag is set.
   */
  allowRelay?: boolean;
  /** libp2p protocol id. Defaults to `PROTOCOL` (`/httpeers/1.0.0`). */
  protocol?: string;
  /**
   * How long to wait for a backpressured stream to drain before dropping a
   * peer that requests something and then stops reading without closing.
   * Defaults to `DEFAULT_DRAIN_TIMEOUT_MS` from `transport-duplex.ts` — see
   * that constant's doc comment for the value and why it is not left at
   * `webrun-streams-libp2p`'s 5-minute default.
   */
  drainTimeoutMs?: number;
  /**
   * Per-connection concurrent stream cap, both directions, both serving and
   * dialing. Defaults to `DEFAULT_MAX_STREAMS` from `transport-duplex.ts`.
   */
  maxStreams?: number;
  /**
   * T-2's request timeout contract for this peer's outbound calls
   * (`remote`/`call`). Defaults to `DEFAULT_REQUEST_TIMEOUT_MS` from
   * `transport-duplex.ts` — see that constant's doc comment for the value
   * and its relationship to `drainTimeoutMs`.
   */
  requestTimeoutMs?: number;
  /**
   * T-3 (Task 18): the width of this peer's outbound admission semaphore —
   * how many of this peer's own `call`/`remote` invocations, across every
   * target peer, may be dialing/negotiating/awaiting a response at once
   * before further calls queue. Defaults to `DEFAULT_MAX_CONCURRENT_OUTBOUND`
   * from `transport-duplex.ts` — see that constant's doc comment for the
   * full contract, including why queueing past it shares `requestTimeoutMs`
   * rather than getting its own timer.
   */
  maxConcurrentOutbound?: number;
  /** Injected clock, threaded into `verifyToken`. Defaults to `Date.now`. */
  now?: () => number;
}

export interface Peer {
  /** This peer's own peerId — the node's, whether caller- or self-supplied. */
  peerId: PeerIdStr;
  /** The underlying libp2p node, for a caller that needs it directly (e.g. `peer.libp2p.dial(...)` to pre-establish a route before `call`). */
  libp2p: Libp2p;
  /** This peer's own listen multiaddrs, as strings. Empty for a dial-only peer. */
  addrs: () => string[];
  /**
   * Dial `targetPeerId` and issue `path` as a request against it — the
   * ergonomic wrapper over `remote`. `init.token`, if given, becomes an
   * `authorization: Bearer <token>` header rather than a raw `RequestInit`
   * field (`fetch`/`Request` have no such field). `path` may itself carry a
   * peer prefix (`/​{otherPeerId}/...`) to ask `targetPeerId` to forward —
   * subject to *its* `allowRelay`/`allowForward` policy, not this peer's.
   */
  call: (
    targetPeerId: PeerIdStr,
    path: string,
    init?: RequestInit & { token?: string },
  ) => Promise<Response>;
  /** The composed router: transport hands every inbound request here. */
  dispatch: FetchHandler;
  /** Dial another peer and get its response. Outbound, identity-free. */
  remote: Remote;
  stop: () => Promise<void>;
}

export async function createPeer(init: CreatePeerInit): Promise<Peer> {
  const {
    node: suppliedNode,
    listen,
    mounts: mountsInit,
    usesTransportIdentity = async () => false,
    revocationCache,
    allowRelay = false,
    protocol = PROTOCOL,
    drainTimeoutMs,
    maxStreams,
    requestTimeoutMs,
    maxConcurrentOutbound,
    now,
  } = init;

  // Defaulted together, as a matched pair, or not at all — see the doc
  // comment on `vocabulary` above for why inheriting one while defaulting
  // the other is exactly the fail-open `withAccessTree`'s required
  // `vocabulary` field was introduced to rule out.
  if ((init.accessTree == null) !== (init.vocabulary == null)) {
    throw new Error(
      "createPeer: accessTree and vocabulary must be supplied together or not at all -- " +
        "defaulting one while inheriting the other risks evaluating a custom access tree " +
        "against a vocabulary it was never validated against (or vice versa).",
    );
  }
  const accessTree = init.accessTree ?? DEFAULT_ACCESS_TREE;
  const vocabulary = init.vocabulary ?? DEFAULT_VOCABULARY;

  // A caller-supplied node is used as-is and never stopped by us — it was
  // never ours to build, so it is never ours to tear down either. A
  // self-built one (via `createNode`, the one place in this package that
  // touches libp2p besides `transport-duplex.ts` itself) is fully ours,
  // `listen`-configured, and stopped in `stop()`.
  //
  // The signing key for a self-built node is generated and retained HERE,
  // not inside `createNode` — `createLibp2p` never hands a generated key
  // back out, so generating it inside the node builder would make it
  // unreachable the moment that call returns. Generating it in this scope
  // is what lets a later task's minting logic close over `privateKey`
  // without threading the node builder's internals back out through it.
  let privateKey = init.privateKey;
  if (suppliedNode == null) privateKey ??= await generateMeshKey();
  const node = suppliedNode ?? (await createNode({ listen, privateKey }));
  const ownsNode = suppliedNode == null;

  const selfPeerId = init.selfPeerId ?? node.peerId.toString();
  // `hubPeerId` is `verifyToken`'s `issuer`: the mesh this peer's tokens
  // must self-certify against. Defaulting to `selfPeerId` means "trust only
  // tokens I minted myself."
  const issuer = init.hubPeerId ?? selfPeerId;

  // Resolve `mounts` now that `privateKey`/`selfPeerId` are settled: a
  // factory gets a `mintToken` closure over the retained key (never the key
  // itself), so an application can mint tokens without this package ever
  // learning what a "hub" is. `privateKey` is only actually missing here for
  // a caller-supplied `node` with no key handed to us — the closure throws
  // lazily, only if a factory that needed it is actually called, rather than
  // failing every plain-`Mounts` or non-minting caller up front.
  const mintTokenForMounts = async (
    sub: string,
    roles: string[],
    ttlMs = DEFAULT_MINT_TTL_MS,
  ): Promise<string> => {
    if (privateKey == null) {
      throw new Error(
        "createPeer: a mounts factory called mintToken, but no signing key is available -- " +
          "supply `privateKey`, or omit `node` so createPeer generates and retains one itself.",
      );
    }
    return mintToken({ privateKey, sub, roles, ttlMs });
  };
  const mounts =
    mountsInit == null
      ? defaultMounts()
      : typeof mountsInit === "function"
        ? mountsInit({ peerId: selfPeerId, mintToken: mintTokenForMounts })
        : mountsInit;

  // --- seams ---------------------------------------------------------------

  // The non-null assertion is DELIBERATE and CORRECT — it asserts the
  // contract that `getPeerId` never returns `undefined` (see `GetPeerId` in
  // types.ts). A real violation (something re-created the `Request` above
  // the binding middleware without `copyPeerBinding`) is a bug, and
  // `newPeerHandlers`'s own runtime check catches it as
  // `PeerBindingLostError` rather than this silently coercing a lost
  // binding into a legitimate ANONYMOUS caller.
  const getPeerId: GetPeerId = async (req) => lookupPeer(req)! as ProvenPeer;

  const getClaims: GetClaims = async (req) => {
    const cached = lookupClaims(req);
    if (cached !== undefined) return cached;
    const header = req.headers.get("authorization");
    const token = header?.startsWith("Bearer ") === true ? header.slice(7) : null;
    let claims: MeshClaims | null = null;
    if (token != null) {
      try {
        claims = await verifyToken(token, { issuer, now });
      } catch {
        claims = null; // any verification failure is treated as "no claims"
      }
    }
    cacheClaims(req, claims);
    return claims;
  };

  // Wrapped here, not made async at the source: `RevocationCache.check` is
  // deliberately synchronous (see revocation.ts); the binding's `isRevoked`
  // seam is `async`, so this is the one-line adapter between them.
  const isRevoked = revocationCache
    ? async (claims: MeshClaims): Promise<string | null> => revocationCache.check(claims)
    : undefined;

  const remote = createRemote({
    node,
    protocol,
    drainTimeoutMs,
    maxOutboundStreams: maxStreams,
    requestTimeoutMs,
    maxConcurrentOutbound,
  });

  const dispatch: FetchHandler = createPeerRouter({
    selfPeerId,
    mounts,
    remote,
    access: (local) =>
      newPeerHandlers({
        getPeerId,
        usesTransportIdentity,
        getClaims,
        isRevoked,
        handleEndpoints: withAccessTree({ tree: accessTree, vocabulary, usesTransportIdentity })(
          local,
        ),
      }),
    allowForward: async (req) => {
      // `undefined` (no binding at all) means this request never passed
      // through our own inbound transport handler — it originated locally,
      // at our own edge, so forwarding it is just this peer routing its own
      // traffic, not relaying for a stranger. Anything else means a proven
      // peer registered it (libp2p's handshake always proves someone), i.e.
      // it arrived from the network, and only an explicitly-configured
      // relay may forward that (R-2: relaying is its own capability, deny
      // by default).
      const peer = lookupPeer(req);
      return peer === undefined || allowRelay;
    },
  });

  const stopServing = await serveTransport({
    node,
    dispatch,
    protocol,
    drainTimeoutMs,
    maxInboundStreams: maxStreams,
    maxOutboundStreams: maxStreams,
  });

  return {
    peerId: selfPeerId,
    libp2p: node,
    addrs: () => node.getMultiaddrs().map((a) => a.toString()),
    async call(targetPeerId, path, callInit = {}) {
      const { token, headers, ...rest } = callInit;
      const requestHeaders = new Headers(headers);
      if (token != null) requestHeaders.set("authorization", `Bearer ${token}`);
      const url = new URL(path, "http://peer");
      return remote(targetPeerId, new Request(url, { ...rest, headers: requestHeaders }));
    },
    dispatch,
    remote,
    async stop() {
      await stopServing();
      if (ownsNode) await node.stop();
    },
  };
}
