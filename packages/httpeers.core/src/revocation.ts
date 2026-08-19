/**
 * A-2: revocation, as a pulled and cached deny list.
 *
 * The heartbeat response carries a version vector; when the policy version
 * changes, the peer fetches the change list and caches it. Providers then
 * reject any token issued BEFORE the change:
 *
 *     reject if claims.iat < changedAt
 *
 * Three properties that make this work, none of them accidental:
 *
 *  1. REVOCATION AND ROLE CHANGE ARE THE SAME MECHANISM. Revocation is a role
 *     change to the empty set. A downgraded member is not locked out — their
 *     next heartbeat mints a token with the reduced roles. Upgrades need no
 *     enforcement at all, since the old token is merely less permissive.
 *
 *  2. NO CLOCK SYNCHRONISATION. Both `iat` and `changedAt` are minted by the
 *     hub, so the comparison is between two hub-issued timestamps. A provider
 *     must never substitute its own clock. Worth stating loudly: the obvious
 *     implementation — "is this token older than the revocation?" using
 *     `Date.now()` — quietly requires synchronised clocks across every peer.
 *
 *  3. THE LIST IS SELF-PRUNING. An entry can be dropped once
 *     `changedAt + maxTokenTtl < now`: no token old enough to be affected can
 *     still be valid. The list stays bounded by "peers changed in the last
 *     token lifetime", which is normally empty.
 *
 * The hub never sits on the critical path of a provider's request — the list
 * is pulled and cached, not consulted per request. `RevocationCache.check`
 * is deliberately synchronous: it is a pure in-memory lookup with nothing to
 * await, and an async signature would invite a future implementation to do
 * I/O on the request path, which is exactly what this design exists to
 * avoid. The `isRevoked` seam on the binding middleware (`peer-handlers.ts`)
 * is `async`, so wiring `check` to it is a wrap-at-the-call-site concern for
 * whichever task assembles the peer, not a reason to change this signature.
 */
import type { PeerIdStr } from "./types.js";

export interface ChangeEntry {
  peerId: PeerIdStr;
  /** Hub time at which this peer's authority changed. */
  changedAt: number;
  /** Roles after the change. Empty means revoked. Informational. */
  roles: string[];
}

// ---------------------------------------------------------------------------
// Hub side
// ---------------------------------------------------------------------------

export interface RevocationRegistryInit {
  /** Longest life of any token this hub mints. Sets the pruning horizon. */
  maxTokenTtlMs: number;
  now?: () => number;
}

export class RevocationRegistry {
  private readonly entries = new Map<PeerIdStr, ChangeEntry>();
  private version = 1;
  private readonly maxTokenTtl: number;
  private readonly now: () => number;

  constructor(init: RevocationRegistryInit) {
    this.maxTokenTtl = init.maxTokenTtlMs;
    this.now = init.now ?? (() => Date.now());
  }

  /** Revocation is a role change to the empty set. */
  revoke(peerId: PeerIdStr): void {
    this.changeRoles(peerId, []);
  }

  changeRoles(peerId: PeerIdStr, roles: string[]): void {
    this.entries.set(peerId, { peerId, changedAt: this.now(), roles });
    this.version++;
  }

  /** Drop entries no live token could be affected by. Returns how many went. */
  prune(): number {
    const horizon = this.now() - this.maxTokenTtl;
    let dropped = 0;
    for (const [id, e] of this.entries) {
      if (e.changedAt < horizon) {
        this.entries.delete(id);
        dropped++;
      }
    }
    // Pruning does NOT bump the version: a peer that missed the entry entirely
    // also holds no token old enough to care.
    return dropped;
  }

  policyVersion(): number {
    return this.version;
  }

  list(): ChangeEntry[] {
    this.prune();
    return [...this.entries.values()];
  }
}

// ---------------------------------------------------------------------------
// Provider side
// ---------------------------------------------------------------------------

export interface RevocationCacheInit {
  /**
   * Reject tokens once the cache is older than this. Availability versus
   * security: too short and a hub outage locks the mesh out, too long and a
   * partitioned provider honours revoked tokens. Omit to never expire, which
   * is a deliberate and dangerous choice.
   *
   * There is a case that no default is correct and this should be required.
   */
  maxStalenessMs?: number;
  now?: () => number;
}

export type StalenessMode = "fresh" | "stale";

export class RevocationCache {
  private entries = new Map<PeerIdStr, ChangeEntry>();
  private version = 0;
  private fetchedAt = 0;
  private readonly maxStaleness?: number;
  private readonly now: () => number;

  constructor(init: RevocationCacheInit = {}) {
    this.maxStaleness = init.maxStalenessMs;
    this.now = init.now ?? (() => Date.now());
  }

  /** Called after fetching the list because the heartbeat reported a new version. */
  update(version: number, entries: ChangeEntry[]): void {
    this.entries = new Map(entries.map((e) => [e.peerId, e]));
    this.version = version;
    this.fetchedAt = this.now();
  }

  knownVersion(): number {
    return this.version;
  }

  staleness(): StalenessMode {
    if (this.maxStaleness == null) return "fresh";
    return this.now() - this.fetchedAt > this.maxStaleness ? "stale" : "fresh";
  }

  /**
   * `null` means accept. A string is the reason to refuse — deliberately not
   * a boolean, so a denial can be explained, as with access decisions.
   *
   * Takes a structural subset of `MeshClaims` (`sub`, `iat`), not the whole
   * shape, so this cache stays usable anywhere a `{ sub, iat }` pair is
   * available without pulling in the rest of the claims contract.
   */
  check(claims: { sub: PeerIdStr; iat: number }): string | null {
    if (this.staleness() === "stale") {
      return "revocation list is stale; refusing rather than guessing";
    }
    const entry = this.entries.get(claims.sub);
    if (entry == null) return null;
    if (claims.iat >= entry.changedAt) return null; // minted after the change
    return entry.roles.length === 0 ? "membership revoked" : "roles changed; obtain a fresh token";
  }
}
