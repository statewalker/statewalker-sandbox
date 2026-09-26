/**
 * Peer assembly: wires Tasks 1-5 onto the transport adapter to produce one
 * running peer.
 *
 * COMPOSITION ORDER IS LOAD-BEARING: transport -> registerPeer -> binding
 * middleware -> access policy -> router -> mounts.
 *
 *   access: (local) => newPeerHandlers({
 *     getPeerId, usesTransportIdentity, getClaims, isRevoked,
 *     handleEndpoints: withPolicy({ rules, usesTransportIdentity, selfPeer: selfPeerId })(local),
 *   })
 *
 * BINDING OUTSIDE, POLICY INSIDE. `withPolicy`'s `lookupClaims` read only
 * works because the binding middleware calls `getClaims` first — which
 * caches via `cacheClaims` — before policy ever runs. Reverse the nesting
 * and policy reads an empty cache: every request would look tokenless to the
 * authorizer, no matter what it actually carried.
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
 * and a `selfPeerId`, receiving only a scoped `mintToken(sub, roles, options?)`
 * closure — never the key itself. An application builds whatever endpoints
 * it needs against that one capability; `createPeer` stays hub-agnostic.
 */

import { cacheClaims, lookupClaims, lookupClaimsResult, lookupPeer } from "./peer-context.js";
import { newPeerHandlers } from "./peer-handlers.js";
import type { RevocationChecker } from "./revocation.js";
import { createMounts, createPeerRouter } from "./router.js";
import type { RuleSet } from "./rules.js";
import { DEFAULT_RULES, withPolicy } from "./rules.js";
import { generateMeshKey, mintToken, TokenVerificationError, verifyToken } from "./tokens.js";
import type { Ed25519PrivateKey, Libp2p } from "./transport-duplex.js";
import { createNode, createRemote, PROTOCOL, serveTransport } from "./transport-duplex.js";
import type {
  ClaimsResult,
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

/** What a mounts factory may say about a token besides who it is for. */
export interface MintForMountsOptions {
  /** Defaults to `DEFAULT_MINT_TTL_MS` when omitted. */
  ttlMs?: number;
  /**
   * The peers this token may be presented to (ADR-0020). Omit for an
   * unrestricted token — which is minted as the explicit unrestricted state,
   * never as silence; see `tokens.ts`'s `MintTokenOptions.audience`.
   *
   * This is the whole reason least privilege is EXPRESSIBLE from an
   * application: without it, a hub built on this seam could only ever mint
   * tokens valid at every peer in the mesh, whatever the token layer beneath
   * it supported.
   */
  audience?: readonly PeerIdStr[];
}

/**
 * What a `mounts` factory receives: this peer's own `peerId`, and a
 * capability to mint membership tokens that self-certify against it — never
 * the signing key itself. See the module comment's "MOUNTS MAY BE A
 * FACTORY" note for why this exists instead of exposing `privateKey`
 * directly.
 */
export interface MountsFactoryContext {
  peerId: PeerIdStr;
  /**
   * Mint a membership token that self-certifies against this peer.
   *
   * The third parameter is an OPTIONS OBJECT, not the bare `ttlMs` number it
   * was before ADR-0020: `audience` is the second thing a caller may want to
   * say about a token, and a second positional argument next to a number is
   * how a call site ends up passing them in the wrong order. Exactly one call
   * site in this repository passed `ttlMs` (the browser hub's self-token
   * renewal), so the churn was one line.
   */
  mintToken: (sub: string, roles: string[], options?: MintForMountsOptions) => Promise<string>;
}

/**
 * The default mount when the caller supplies no `mounts` table of its own:
 * a diagnostic `/test/whoami` that echoes back what the transport and
 * binding proved for the request (the connected peer, and the token's
 * `sub` once verified). `DEFAULT_RULES`'s `/test` policy (requires
 * `std:test`, which the same rule set derives from `role("member")`) is
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
   * This peer's own signing key. When `node` is supplied, only key
   * *generation* is skipped -- the value itself is not ignored: it is
   * still what `mintTokenForMounts` below closes over, so a `node` handed
   * in without one builds and starts fine, and only fails lazily, at the
   * first `mintToken` call a mounts factory actually makes. For a
   * self-constructed node, omit it to have `createPeer` generate one and
   * retain it — `createLibp2p` never hands a generated key back out, so if
   * nothing above it keeps the reference before the node is built, it is
   * gone for good, and this peer could never later mint a token that
   * self-certifies as its own peerId (`mintToken`/`verifyToken`'s
   * self-certification check in `tokens.ts` ties a valid token's `mesh` to
   * the actual signing key's peerId). Not exposed on the returned `Peer`
   * — retaining it here, for a later task's minting logic to close over,
   * is the point; publishing it is not.
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
   * This peer's Datalog rules and policies (ADR-0019). Defaults to
   * `DEFAULT_RULES`.
   *
   * ONE VALUE, NOT A PAIR. Its predecessor was two — `accessTree` and
   * `vocabulary` — and `createPeer` had to refuse a caller who supplied one
   * and inherited the other, because a tree evaluated against a
   * role→capability mapping it was never validated against is a fail-open.
   * A `RuleSet` carries the derivation and the policies that consume it in
   * one validated value, so that whole class of mismatch has nowhere left to
   * live (X-02).
   */
  rules?: RuleSet;
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
   * A revocation decision, checked synchronously per request via the
   * `RevocationChecker` shape (`revocation.ts`) — `.check(claims) -> reason
   * | null`. Optional — omit and nothing is ever revoked. Despite the field
   * name (kept for compatibility with every existing caller), this is NOT
   * always a cache: a REMOTE provider with no direct line to the hub's state
   * passes a `RevocationCache` (a pulled-and-cached snapshot, fetched on its
   * own schedule); the hub itself, which owns the live `RevocationRegistry`,
   * passes that registry directly — it has nothing to pull from itself and
   * needs no synchronised copy. Either way, `.check` is deliberately
   * synchronous (a pure in-memory lookup); this field is the
   * wrap-at-the-call-site the binding's `isRevoked` seam (which is `async`)
   * was left for.
   */
  revocationCache?: RevocationChecker;
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
  /**
   * Injected clock, threaded into both `verifyToken` (expiry checks) and a
   * `mounts` factory's `mintToken` (the `iat` it stamps). Defaults to
   * `Date.now`. A hub that also owns a `RevocationRegistry` should pass the
   * SAME `clock.ts` `createMonotonicClock()` instance here and to that
   * registry's own `now` — see `revocation.ts`'s "ONE HUB-ISSUED CLOCK, NOT
   * TWO" for why two independently-defaulted `Date.now` clocks can tie.
   */
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

  const rules = init.rules ?? DEFAULT_RULES;

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
  //
  // `now` is threaded through here too, not just into `verifyToken` below —
  // a hub that passes a shared `clock.ts` `createMonotonicClock()` instance
  // as `init.now` needs its OWN minting to draw from that same instance, or
  // sharing it with a `RevocationRegistry` built from the same clock buys
  // nothing (see `revocation.ts`'s "ONE HUB-ISSUED CLOCK, NOT TWO"). Omitted
  // entirely, this is `undefined`, and `mintToken` falls back to its own
  // `Date.now` default exactly as before.
  const mintTokenForMounts = async (
    sub: string,
    roles: string[],
    options: MintForMountsOptions = {},
  ): Promise<string> => {
    if (privateKey == null) {
      throw new Error(
        "createPeer: a mounts factory called mintToken, but no signing key is available -- " +
          "supply `privateKey`, or omit `node` so createPeer generates and retains one itself.",
      );
    }
    // `audience` is spread rather than passed as `audience: options.audience`:
    // `mintToken` distinguishes an absent audience (unrestricted) from an
    // empty one (refused), and an explicit `undefined` property would be the
    // former, which is right, but spreading says so without relying on it.
    return mintToken({
      privateKey,
      sub,
      roles,
      ttlMs: options.ttlMs ?? DEFAULT_MINT_TTL_MS,
      ...(options.audience !== undefined ? { audience: options.audience } : {}),
      now,
    });
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

  // `connectionPeer` is what the transport handshake proved for THIS request —
  // `lookupPeer`, the same source `getPeerId` above reads, never a header. It
  // is what `verifyToken` asserts as `connection_peer`, which the token's own
  // `check if bound($k), connection_peer($k)` consumes: ADR-0009's binding,
  // enforced by the token rather than only in `peer-handlers.ts`'s prose.
  //
  // A consequence worth stating: a REPLAYED token — genuine, unexpired, but
  // presented over somebody else's connection — fails VERIFICATION rather
  // than `peer-handlers.ts`'s own `claims.sub !== peer` comparison. It is
  // refused as 401 "token subject does not match connected peer" (the
  // `peer-binding` reason), keeping its own reason because this function now
  // REPORTS the refusal instead of flattening it into "no token". 401 rather
  // than 403 because the same state is what an honest page produces by
  // resetting its identity while holding a token minted for its old key, and
  // a refresh fixes that — see `REFUSAL_STATUS` in `peer-handlers.ts`.
  // `peer-handlers.ts` keeps its own comparison because its `getClaims` is an
  // INJECTED seam and a supplier that does not bind must still be refused
  // there — at 403, deliberately, for the reason given at that line.
  //
  // WHY THIS RETURNS A RESULT AND NOT `MeshClaims | null`. It used to catch
  // every `TokenVerificationError` into `claims = null`, which made "no token
  // was presented" and "a token was presented and rejected" the same value.
  // `newPeerHandlers` then had to answer 401 "membership token required" to
  // both — including to a client whose token names a different audience,
  // which refreshes and is refused identically, forever. The reason was
  // always here, on the caught error; only the return type could not carry
  // it. See `ClaimsResult` in `types.ts`.
  //
  // `lookupPeer` returning `undefined` means the binding was lost above this
  // middleware (a bug — see `PeerBindingLostError`). Passing `ANONYMOUS` on
  // that path asserts no `connection_peer` at all, so the token is refused;
  // `newPeerHandlers`'s own check is what reports the bug as such.
  const getClaims: GetClaims = async (req) => {
    const cached = lookupClaimsResult(req);
    if (cached !== undefined) return cached;
    const header = req.headers.get("authorization");
    const token = header?.startsWith("Bearer ") === true ? header.slice(7) : null;
    let result: ClaimsResult;
    if (token == null) {
      result = { status: "absent" };
    } else {
      try {
        const claims = await verifyToken(token, {
          issuer,
          connectionPeer: lookupPeer(req) ?? ANONYMOUS,
          // ADR-0020: THIS peer's own identity, so an audience-scoped token
          // is checked against the destination that actually received the
          // request — not against whatever the route claimed on the way. A
          // peer that is not an intended audience refuses here, before any
          // policy runs, and refuses identically whether the request was
          // dialled straight at it or forwarded to it.
          selfPeer: selfPeerId,
          now,
        });
        result = { status: "verified", claims };
      } catch (error) {
        // Anything that is not a `TokenVerificationError` came from below the
        // token layer (a wasm trap, say) and has no reason of its own. It is
        // reported as `malformed-token` — the honest statement that these
        // bytes could not be made sense of — rather than as a state the
        // taxonomy does not have.
        result =
          error instanceof TokenVerificationError
            ? {
                status: "refused",
                reason: error.reason,
                detail: error.detail,
                failedChecks: error.failedChecks,
              }
            : {
                status: "refused",
                reason: "malformed-token",
                detail: "malformed token",
                failedChecks: [],
              };
      }
    }
    cacheClaims(req, result);
    return result;
  };

  // Wrapped here, not made async at the source: `RevocationChecker.check` is
  // deliberately synchronous (see revocation.ts) whether the caller passed a
  // `RevocationCache` or a `RevocationRegistry`; the binding's `isRevoked`
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
        handleEndpoints: withPolicy({ rules, usesTransportIdentity, selfPeer: selfPeerId, now })(
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
