/**
 * Revocation as a pulled, cached deny list.
 *
 * The problem: a token is valid until it expires, so removing a member leaves
 * them holding a working credential for up to the TTL. Shortening the TTL
 * trades that for constant re-minting.
 *
 * The chosen shape: the hub keeps a change list with a monotonic version. The
 * heartbeat a peer already sends returns that version, so a provider pulls the
 * list **only when the counter moves** — the hub is never on the critical path
 * of a request. Providers cache it and refuse tokens minted before the change.
 *
 * `iat` is what makes it work. Without an issued-at, revocation is
 * all-or-nothing: you cannot tell a token minted before a role change from one
 * minted after, so re-admitting a member is impossible.
 */

export interface Claims {
  sub: string;
  mesh: string;
  roles: string[];
  /** Issued-at, in HUB time — compared against hub-issued changedAt. */
  iat: number;
  exp: number;
}

export interface ChangeEntry {
  peerId: string;
  /** Tokens issued before this instant are no longer honoured. */
  changedAt: number;
  reason: "removed" | "roles-changed";
}

export class Hub {
  private readonly changes = new Map<string, ChangeEntry>();
  private version = 0;
  private clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  mint(peerId: string, roles: string[], ttlMs: number): Claims {
    const now = this.clock();
    return { sub: peerId, mesh: "H", roles, iat: now, exp: now + ttlMs };
  }

  remove(peerId: string): void {
    this.changes.set(peerId, { peerId, changedAt: this.clock(), reason: "removed" });
    this.version += 1;
  }

  setRoles(peerId: string): void {
    this.changes.set(peerId, { peerId, changedAt: this.clock(), reason: "roles-changed" });
    this.version += 1;
  }

  /** What a heartbeat returns: the counter, so the peer knows to re-pull. */
  policyVersion(): number {
    return this.version;
  }

  changeList(): { version: number; entries: ChangeEntry[] } {
    return { version: this.version, entries: [...this.changes.values()] };
  }
}

export class RevocationCache {
  private entries = new Map<string, ChangeEntry>();
  private known = -1;

  knownVersion(): number {
    return this.known;
  }

  /** Called only when the heartbeat says the counter moved. */
  update(list: { version: number; entries: ChangeEntry[] }): void {
    this.entries = new Map(list.entries.map((e) => [e.peerId, e]));
    this.known = list.version;
  }

  /** null = accept. A string = the reason for refusing. */
  check(claims: Claims): string | null {
    const entry = this.entries.get(claims.sub);
    if (entry === undefined) return null;
    if (claims.iat < entry.changedAt) {
      return entry.reason === "removed"
        ? "member removed"
        : "roles changed since this token was minted";
    }
    return null; // minted after the change — a re-admitted member
  }
}
