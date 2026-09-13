/**
 * 07 — the candidate API, as TYPES ONLY.
 *
 * WHY THIS FILE EXISTS. Three rounds of adversarial review over a prose
 * specification produced fixes that introduced worse defects than they closed,
 * two consumers that could not be built, and a new mis-citation every round.
 * The two most valuable findings in that whole exercise were obtained by
 * TYPECHECKING an example and by RUNNING a sample — not by reading. So the
 * API is expressed here as TypeScript and judged by `tsc`: a missing seam is
 * a compile error in `../ports/*.ts`, not a paragraph somebody has to notice.
 *
 * There is no implementation anywhere in this rung, on purpose. `../src/
 * stubs.ts` declares the surface; the ports are written against it exactly as
 * an application would be. If a port cannot be written, the API is incomplete
 * and the rung has failed — which is the only claim this rung makes.
 *
 * FIVE DEFECTS OF THE PROSE DESIGN ARE FIXED HERE BY CONSTRUCTION, each one
 * proven against the prototype by an earlier critic:
 *
 *   1. `callerOf()` returned `undefined` for BOTH "not bound — a bug" and
 *      "originated locally, so forward it and attach our token". Overloading
 *      those two made the forward path fail OPEN. Here `Caller` is a closed
 *      union with a distinct `local` arm, and the accessor throws when
 *      nothing was bound at all.
 *   2. Minting was added by deleting the verifier's issuer, so no member
 *      could check a signature. Here `Access` is built BY the mesh
 *      (`AccessFactory`), so a verifier always knows its issuer.
 *   3. Revocation had no seam in the construction order. Here `Revocations`
 *      is created first and handed to both the access layer and the hub —
 *      one live object, shared by construction.
 *   4. The bootstrap exemption was prose with zero call sites. Here it is a
 *      field on `ServeOptions`, so a mount either declares it or does not.
 *   5. The ghost's `appPath` blacklist was defeated by a backslash. Here a
 *      `Landing` cannot be constructed except through `landing()`, which
 *      returns a branded type.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type PeerId = string & { readonly __brand: "PeerId" };
export type MeshId = PeerId;

/** Opaque, validated at construction. See `landing()`. */
export type AppPath = string & { readonly __brand: "AppPath" };

/** A built, validated policy. Never a bare string — a bare string cannot be checked at build time. */
export type Policy = { readonly __brand: "Policy" };

export type Unmount = () => void;

// ---------------------------------------------------------------------------
// The one handler contract, and the caller beside it
// ---------------------------------------------------------------------------

/** Unchanged from the prototype, and deliberately fetch-shaped: a Hono app already is one. */
export type Handler = (request: Request) => Promise<Response>;

/**
 * WHO IS CALLING. A closed union, because the prose version's `undefined`
 * meant two incompatible things and the ambiguity failed open.
 *
 * `local` is not a weaker `peer` — it is the statement "this request
 * originated at our own edge and crossed no network", which is what licenses
 * attaching our own credential to it. An inbound network request is never
 * `local`, so an inbound request can never borrow our membership.
 */
export type Caller =
  | { readonly kind: "peer"; readonly peerId: PeerId }
  | { readonly kind: "anonymous" }
  | { readonly kind: "local" };

/** Throws `UnboundRequest` when nothing bound this request — a transport defect, never a silent pass. */
export declare function callerOf(request: Request): Caller;
/** Carry the binding across a re-created Request. Any handler that rebuilds a request must call it. */
export declare function carryCaller(from: Request, to: Request): void;

export declare class UnboundRequest extends Error {}

// ---------------------------------------------------------------------------
// Claims and access
// ---------------------------------------------------------------------------

export interface Claims {
  readonly sub: PeerId;
  readonly mesh: MeshId;
  readonly roles: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Live deny-list, shared by the hub that writes it and the access layer that reads it. */
export interface Revocations {
  /** `null` when the claims are still good; otherwise the reason. */
  check(claims: Claims): string | null;
  /** Hub side. Bumps `version`. */
  revoke(peerId: PeerId, at?: number): void;
  readonly version: number;
}
export declare function createRevocations(now?: () => number): Revocations;

export interface VerifyContext {
  readonly caller: Caller;
  readonly self: PeerId;
  readonly operation: string;
  readonly resource: string;
}

/**
 * Access for ONE mesh. Built by `AccessFactory` once the mesh is known, which
 * is why a verifier always has its issuer.
 */
export interface Access {
  readonly mesh: MeshId;
  /** Inbound gate for a fetch mount. */
  guard(handler: Handler, policy: Policy): Handler;
  /** Inbound gate for a duplex mount, which has no Request to guard. */
  check(ctx: VerifyContext & { token?: string }): Promise<Claims | null>;
  /** Build and validate a policy. Throws, listing every problem, if it cannot be satisfied by the vocabulary. */
  policy(...clauses: readonly string[]): Policy;
  /** Present only where this node holds the mesh key — i.e. a hub. */
  readonly issuer?: Issuer;
}

export interface Issuer {
  mint(init: {
    sub: PeerId;
    roles: readonly string[];
    ttlMs: number;
    audience?: readonly PeerId[];
  }): Promise<string>;
}

/**
 * The mesh is not known until an invitation is read or a memory is loaded, so
 * access is constructed after it. `revocations` is passed in rather than
 * created here: the hub owns the writer, everyone shares the reader.
 */
export type AccessFactory = (init: {
  mesh: MeshId;
  revocations: Revocations;
  /** Present only on a hub: the key that mints for this mesh. */
  signWith?: PrivateKey;
}) => Promise<Access>;

export declare class AccessDenied extends Error {
  readonly reason: string;
  readonly status: number;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Raw key bytes — the libp2p protobuf both platforms already store. Never a string. */
export type PrivateKey = Uint8Array & { readonly __brand: "PrivateKey" };

export interface IdentityStore {
  read(): Promise<PrivateKey | null>;
  loadOrCreate(): Promise<PrivateKey>;
  /** The harness and `pnpm bootstrap` install a chosen key; without this they are outside the API. */
  put(key: PrivateKey): Promise<void>;
  clear(): Promise<void>;
}

export declare function peerIdOf(key: PrivateKey): PeerId;
export declare function generateKey(init?: { seed?: string }): Promise<PrivateKey>;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface Connection {
  readonly peerId: PeerId;
  readonly limited: boolean;
  close(): Promise<void>;
}

export type TransportEvent =
  | { kind: "connection:open"; peerId: PeerId }
  | { kind: "connection:close"; peerId: PeerId }
  | { kind: "reservation"; addr: string }
  | { kind: "reservation:lost" };

export interface Transport {
  readonly peerId: PeerId;
  addrs(): readonly string[];
  /** Bind a listen address AFTER start; resolves once it appears in `addrs()`. */
  listen(addr: string): Promise<void>;
  connections(peerId?: PeerId): readonly Connection[];
  reach(addr: string): Promise<Connection>;
  hangUp(peerId: PeerId): Promise<void>;
  /** The transport MUST bind a `Caller` to every inbound request before the handler sees it. */
  serve(handler: Handler): Promise<Unmount>;
  serveDuplex(handler: RawDuplexHandler): Promise<Unmount>;
  call(peerId: PeerId, request: Request, init?: { hints?: readonly string[] }): Promise<Response>;
  open(peerId: PeerId, init?: { hints?: readonly string[] }): Promise<Duplex>;
  on(listener: (event: TransportEvent) => void): Unmount;
  stop(): Promise<void>;
}

/** Built after the mesh is resolved, because the relay address arrives with the invitation. */
export type TransportFactory = (init: {
  key: PrivateKey;
  relayAddrs: readonly string[];
  /** Read live, per gater call: a hub's membership predicate does not exist when its node is built. */
  isMember?: () => (peerId: PeerId) => boolean;
  relayService?: boolean;
}) => Promise<Transport>;

// ---------------------------------------------------------------------------
// Duplex — the lower altitude
// ---------------------------------------------------------------------------

export type Duplex = (input: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>;

export interface DuplexContext {
  readonly caller: Caller;
  readonly path: string;
  readonly claims: Claims | null;
  /** Fires when the caller's membership is revoked mid-stream. A long stream is authorised once at open without it. */
  readonly revoked: Promise<string>;
}

export type DuplexHandler = (
  input: AsyncIterable<Uint8Array>,
  ctx: DuplexContext,
) => AsyncIterable<Uint8Array>;

/** What the transport serves: no path yet, because the open frame has not been read. */
export type RawDuplexHandler = (caller: Caller) => Duplex;

export interface PeerDuplex {
  readonly peerId: PeerId;
  readonly path: string;
  readonly call: Duplex;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

export interface ServeOptions {
  policy: Policy;
  /**
   * Runs on transport identity alone, before any token. The two bootstrap
   * routes need it; everything else must not have it. A mount either declares
   * it or does not — it is not prose.
   */
  usesTransportIdentity?: boolean;
}

export interface Node {
  readonly peerId: PeerId;
  readonly access: Access;
  readonly transport: Transport;
  /** Addressed, never path-derived. The ghost depends on this distinction. */
  call(peerId: PeerId, request: Request): Promise<Response>;
  open(peerId: PeerId, path: string): Promise<PeerDuplex>;
  ensureRoute(peerId: PeerId): Promise<void>;
  serve(prefix: string, handler: Handler, opts: ServeOptions): Unmount;
  serveDuplex(prefix: string, handler: DuplexHandler, opts: ServeOptions): Unmount;
  /** What the transport serves and what an in-process test calls. Never published to a page. */
  readonly inbound: Handler;
  stop(): Promise<void>;
}

export declare function createNode(init: {
  transport: Transport;
  access: Access;
  relay?: boolean;
}): Promise<Node>;

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export interface Advertisement {
  id: string;
  kind: string;
  title: string;
}

export interface PeerInfo {
  peerId: PeerId;
  roles: readonly string[];
  addrs: readonly string[];
  online: boolean;
  offers: readonly Advertisement[];
}

export interface MeshSnapshot {
  version: number;
  self: PeerId;
  peers: readonly PeerInfo[];
  /** Flat, and independent of `peers`: the hub advertises under its own id and is in no peer list. */
  offers: readonly (Advertisement & { peerId: PeerId })[];
}

export type PresenceRefusal =
  | { kind: "duplicate-identity"; message: string }
  | { kind: "stale-sequence"; message: string }
  | { kind: "not-a-member"; message: string };

export interface Membership {
  readonly mesh: MeshId;
  readonly roles: readonly string[];
  token(): string;
  /** `null` until the first heartbeat lands — a caller must be able to say "no view yet". */
  view(): MeshSnapshot | null;
  advertise(supplier: () => readonly Advertisement[]): Unmount;
  /** Drive one heartbeat by hand. The harness runs at a 2 s TTL and cannot wait for a 5 s timer. */
  beat(): Promise<void>;
  leave(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export interface MeshRef {
  relayAddrs: readonly string[];
  hub: PeerId;
}

export type JoinInput =
  | { kind: "blob"; mesh: MeshRef; invitationId: string }
  /** An id alone names no mesh, so the deployment's must accompany it. */
  | { kind: "id"; invitationId: string; mesh: MeshRef }
  | { kind: "resume"; mesh: MeshRef };

export declare function readJoinInput(text: string, fallback?: MeshRef): JoinInput | null;
export declare function encodeInvitation(mesh: MeshRef, invitationId: string): string;

export interface MeshMemory {
  read(): Promise<MeshRef | null>;
  write(ref: MeshRef): Promise<void>;
  clear(): Promise<void>;
}

export declare class JoinFailed extends Error {
  readonly reason:
    | "not-a-member"
    | "duplicate-identity"
    | "presence-refused"
    | "invitation-refused"
    | "no-mesh";
  readonly peerId: PeerId;
  readonly refusal?: PresenceRefusal;
}
export declare class Busy extends Error {}

export type Phase =
  | { kind: "idle" }
  | { kind: "joining"; step: string }
  | { kind: "live" }
  | { kind: "refused"; refusal: PresenceRefusal }
  | { kind: "failed"; error: JoinFailed };

export interface Events {
  now(): Phase;
  on(listener: (phase: Phase) => void): Unmount;
}

/** The whole join, in one call. Re-callable: a failed attempt stops everything it built. */
export declare function connect(init: {
  transport: TransportFactory;
  access: AccessFactory;
  identity: IdentityStore;
  memory?: MeshMemory;
  revocations?: Revocations;
  join: JoinInput;
  serve?: Record<string, readonly [Handler, Policy]>;
  publish?: () => readonly Advertisement[];
  heartbeatMs?: number;
}): Promise<Session>;

export interface Session {
  readonly node: Node;
  readonly membership: Membership;
  readonly events: Events;
  /** Stop presence but stay callable — what a revocation test needs and a page's disconnect button uses. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

export interface Storage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface InvitationRecord {
  id: string;
  roles: readonly string[];
  expiresAt: number;
  state: "unspent" | "redeemed" | "expired";
}

export interface Hub {
  /** The hub's own credential for its own edge, rotated internally. */
  token(): string;
  invite(init?: { roles?: readonly string[]; ttlMs?: number; id?: string }): Promise<{
    id: string;
    text: string;
    url(base: string): string;
  }>;
  invitations(): readonly InvitationRecord[];
  members(): readonly PeerInfo[];
  isMember(peerId: PeerId): boolean;
  setRoles(peerId: PeerId, roles: readonly string[]): Promise<{ policyVersion: number }>;
  remove(peerId: PeerId): Promise<{ policyVersion: number }>;
  /** The hub's own unfiltered view. `view(caller)` filters per caller. */
  view(caller?: PeerId): MeshSnapshot;
  advertise(supplier: () => readonly Advertisement[]): Unmount;
  sweep(): void;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export declare function serveHub(
  node: Node,
  init: {
    storage: Storage;
    revocations: Revocations;
    relayAddrs: readonly string[];
    presenceTtlMs?: number;
    sweepMs?: number;
    advertisementAccess?: Readonly<Record<string, string>>;
    extra?: Record<string, readonly [Handler, Policy]>;
  },
): Promise<Hub>;

// ---------------------------------------------------------------------------
// Expose
// ---------------------------------------------------------------------------

export interface Route {
  prefix: string;
  describe: string;
  upstream: Handler;
}

export interface StoredRoute {
  prefix: string;
  upstream: string;
  describe: string;
  /** The header NAME. The value never leaves memory. */
  secretHeader: string | null;
}

export interface RouteStore {
  /** `undefined` means never written, which is not the same as an empty list. */
  load(): Promise<StoredRoute[] | undefined>;
  save(routes: readonly StoredRoute[]): Promise<void>;
}

/** Thunk only: the proxy page edits routes while traffic flows. */
export declare function routes(
  supplier: () => readonly Route[],
  init?: { mountPrefix?: string },
): Handler;

export declare function upstream(init: {
  base: string;
  headers?: Readonly<Record<string, string>>;
  credential?: () => Readonly<Record<string, string>> | undefined;
  /** Node only: a browser drops `Via` silently. */
  via?: string;
  fetchImpl?: typeof fetch;
}): Handler;

export declare function validateRoutes(routes: readonly Route[]): readonly string[];
export declare const PROXY_MARKER: "x-httpeers-proxy";

// ---------------------------------------------------------------------------
// Gateway — the mesh as ordinary HTTP
// ---------------------------------------------------------------------------

/**
 * One handler that serves the whole mesh at `/{peerId}/{servicePath}`.
 * Isomorphic: mount it behind @hono/node-server, a ServiceWorker, or a relay.
 */
export declare function createGateway(init: {
  node: Node;
  /** Stripped before dispatch. "" on Node; "/{key}" behind a ServiceWorker, which cannot mount at "/". */
  basePath?: string;
  token: () => string;
  /** Powers `GET {basePath}/`. Enumerates peers and advertised kinds — never URLs. */
  view?: () => MeshSnapshot | null;
}): Handler;

export declare function parseGatewayPath(
  pathname: string,
  basePath: string,
): { peerId: PeerId | null; path: string };

// ---------------------------------------------------------------------------
// Ghost
// ---------------------------------------------------------------------------

export interface Landing {
  readonly peerId: PeerId;
  readonly appPath: AppPath;
}

/** The only way to build a Landing. Rejects `@`, `\`, `//` and anything not path-shaped. */
export declare function landing(peerId: PeerId, appPath: string): Landing;
export declare function pin(
  node: Node,
  init: { landing: Landing; basePath: string; token: () => string },
): Handler;
