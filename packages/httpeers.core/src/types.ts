/**
 * Shared contracts for the httpeers mesh.
 *
 * This file imports nothing. Anything in the mesh — hub, provider, client,
 * or a test — can depend on it without pulling in libp2p, crypto, or a
 * store's runtime.
 */

/** A libp2p `fetch` handler: the shape every peer serves and calls. */
export type FetchHandler = (req: Request) => Promise<Response>;

/**
 * The sentinel for "no member was proven for this call."
 *
 * Never use `undefined` for this. `undefined` means a binding is missing —
 * a caller that forgot to set the field, which is a bug. `ANONYMOUS` means a
 * binding was made, deliberately, to "nobody proven" — a legitimate policy
 * input (an open, unauthenticated route serves anonymous callers on
 * purpose). Code that branches on identity must be able to tell "nobody
 * wired this up" apart from "this call really is anonymous." Absence is a
 * bug; anonymity is a value.
 */
export const ANONYMOUS: unique symbol = Symbol("httpeers.anonymous");

/**
 * A signed membership claim, minted by a mesh's hub.
 *
 * Field-compatible with the `Claims` shape used by the revocation prototype
 * (`sub`, `mesh`, `roles`, `iat`, `exp` — see `apps/httpeers-protos/lib/
 * revocation.ts`), plus `iss`: the standard JWT issuer claim, carried for
 * interop with generic JWT tooling. In this reference deployment one hub
 * serves one mesh, so `iss` and `mesh` are minted with the same peerId; they
 * stay separate fields because a federated or key-rotating mesh may one day
 * need "who signed this" (`iss`) to differ from "which mesh this grants
 * membership in" (`mesh`).
 *
 * The token is self-certifying: `mesh` names the hub's own peerId, so a
 * verifier who recovers the signing key from that same peerId learns, from
 * one check, both "this signature is valid" and "the signer is who it
 * claims to be." `sub === provenPeer` (did the caller who presented this
 * token prove, via the transport handshake, that they are the subject) is
 * left to the binding middleware — it is not a token-verification concern.
 */
export interface MeshClaims {
  /** peerId of the member this token was minted for. */
  sub: string;
  /** peerId of the signing hub — the standard JWT issuer claim. */
  iss: string;
  /**
   * peerId of the hub whose membership this token grants. Checked against
   * the verifying policy's expected issuer — the self-certification check.
   */
  mesh: string;
  roles: string[];
  /**
   * Issued-at, in hub time. Without it, revocation is all-or-nothing: there
   * is no way to tell a token minted before a role change from one minted
   * after, so re-admitting a member is impossible.
   */
  iat: number;
  /** Expiry, in hub time. */
  exp: number;
}

/** A durable membership record kept by the hub. */
export interface MemberRecord {
  /** peerId of the member. */
  peerId: string;
  roles: string[];
  /** When this member was added (or last had its roles replaced), in hub time. */
  updatedAt: number;
}

/**
 * The hub's durable member registry: who belongs to the mesh and with what
 * roles. Membership persists until explicitly removed — there is no TTL
 * here. (Revoking a live token before its `exp` is a separate concern; see
 * `revocation.ts` in the prototype app, which a later task promotes.)
 */
export interface MemberStore {
  add(peerId: string, roles: string[]): MemberRecord;
  setRoles(peerId: string, roles: string[]): MemberRecord;
  remove(peerId: string): void;
  get(peerId: string): MemberRecord | undefined;
  list(): MemberRecord[];
}

/** One peer's last-known liveness, as stamped by the hub. */
export interface PresenceRecord {
  peerId: string;
  /** Monotonic per-peer sequence number supplied by the caller. */
  seq: number;
  /** Hub time after which this record is considered stale and may be swept. */
  expiresAt: number;
}

/** Why a presence write was refused. */
export type PresenceWriteRejection = "stale-sequence";

export type PresenceWriteResult =
  | { accepted: true; record: PresenceRecord }
  | { accepted: false; reason: PresenceWriteRejection };

/**
 * The hub's presence registry: a TTL'd, swept table of "who is live right
 * now."
 *
 * Writes are monotonic per peer: a write is accepted only if its `seq` is
 * strictly greater than the peer's last accepted `seq`. This is deliberate
 * — a delayed retry (a heartbeat that got stuck in the network and arrives
 * late) must not resurrect a peer that has since sent a newer heartbeat or
 * left. Sequence numbers are supplied by the caller and compared per peer
 * only; there is no cross-peer ordering guarantee, and wall-clock time is
 * never compared across peers.
 */
export interface PresenceStore {
  heartbeat(peerId: string, seq: number, ttlMs: number): PresenceWriteResult;
  isPresent(peerId: string): boolean;
  get(peerId: string): PresenceRecord | undefined;
  list(): PresenceRecord[];
  /** Remove every record whose `expiresAt` has passed. Returns the removed peerIds. */
  sweep(): string[];
}

/** One capability a peer has posted to the mesh's bulletin board. */
export interface Advertisement {
  peerId: string;
  /** The capability or route being advertised, e.g. a service name. */
  key: string;
  payload: unknown;
  postedAt: number;
}

/**
 * The hub's advertisement registry: a bulletin board of what peers offer.
 * Unlike presence, entries are durable — they persist until the posting
 * peer replaces or withdraws them, not on a timer.
 */
export interface AdvertisementStore {
  post(peerId: string, key: string, payload: unknown): Advertisement;
  withdraw(peerId: string, key: string): void;
  get(peerId: string, key: string): Advertisement | undefined;
  /** All advertisements, optionally filtered to one peer. */
  list(peerId?: string): Advertisement[];
}
