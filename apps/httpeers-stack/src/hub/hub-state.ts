/**
 * The hub's durable state — members and spent invitation ids — over an
 * INJECTED `SnapshotStore`, with no idea where that store puts anything.
 *
 * WHY THIS IS ITS OWN FILE, SEPARATE FROM `./persist.ts`. The
 * `SnapshotStore` seam exists so the same hub logic can run in a browser
 * page (`../pages/hub/`, Task 24) as well as in the Node process, and a
 * seam is only as portable as the module that declares it: `persist.ts`
 * imports `node:fs`/`node:path` at module scope for its own file store, so
 * a browser bundle that reached `createPersistentHub` dragged both in with
 * it. Vite does not fail that build — it substitutes a stub that throws on
 * first property access — so the failure would have surfaced at runtime, in
 * a tab, as an error naming `node:fs` and nothing about the hub. Everything
 * in THIS file is storage-agnostic and free of `node:` imports; `persist.ts`
 * keeps the Node file store and re-exports all of this unchanged, so no
 * existing caller (or test) sees a different API.
 *
 * PRESENCE IS DELIBERATELY NOT HERE. It is TTL'd and regenerates within one
 * heartbeat interval of a restart — persisting it would only let a stale
 * "who was online" view survive past the moment it stopped being true.
 *
 * INVITATIONS THEMSELVES ARE ALSO NOT HERE — only which ids have already
 * been *spent*. An unredeemed invitation forgotten across a restart is a
 * minor inconvenience (issue a new one); a redeemed one becoming redeemable
 * again is a membership bypass. Persisting exactly the set that guards
 * against the second, and nothing else, is the smallest state that closes
 * the hole. See `createInvitationStore` below: the spent-id check runs
 * *before* the invitation is even looked up, so a code whose invitation
 * record did not survive a restart still cannot be redeemed twice.
 */
import type { MemberRecord, MemberStore, RuleSet } from "@statewalker/httpeers.core";
import { assertValid, validateRoles } from "@statewalker/httpeers.core";

export interface HubSnapshot {
  members: MemberRecord[];
  spentInvitationIds: string[];
}

/** What a store with nothing in it yet must read as — see `SnapshotStore.read`. */
export const EMPTY_SNAPSHOT: HubSnapshot = { members: [], spentInvitationIds: [] };

/**
 * Where a hub's snapshot lives. THE ONE SEAM BETWEEN THE HUB'S STATE AND
 * ANY PARTICULAR STORAGE -- `./persist.ts`'s `createFileSnapshotStore` is
 * the Node one (a JSON file), `../browser/snapshot-store.ts`'s is the
 * browser one (IndexedDB); nothing else in this file knows either exists.
 *
 * `read` returns `EMPTY_SNAPSHOT`-shaped state on a first run rather than
 * throwing: "nothing stored yet" is the normal first case, not a fault.
 *
 * `write` is synchronous on purpose: every mutation below calls it and then
 * returns, so an async store would open a window where the caller has been
 * told a member was added while the snapshot still says otherwise. A browser
 * implementation that can only write asynchronously must therefore keep an
 * in-memory copy authoritative and flush behind it, rather than making these
 * methods async. See `../browser/snapshot-store.ts` for the one that does.
 */
export interface SnapshotStore {
  read(): HubSnapshot;
  write(snapshot: HubSnapshot): void;
}

export interface PersistentHub {
  memberStore: MemberStore;
  invitations: InvitationStore;
}

export interface InvitationRecord {
  id: string;
  roles: string[];
  expiresAt: number;
}

export type InvitationRedemption =
  | { ok: true; roles: string[] }
  | { ok: false; reason: "not-found" | "expired" | "already-redeemed" };

export interface InvitationStore {
  /** Throws (via `assertValid`) if any role is one no rule of `rules` knows — caught where the invitation is made, not three hops later. */
  create(id: string, roles: string[], ttlMs: number): InvitationRecord;
  redeem(id: string): InvitationRedemption;
}

export interface CreateHubStateInit {
  /** Where the snapshot is loaded from at construction and written back to after every mutation. */
  store: SnapshotStore;
  /** This mesh's rules — the role registry `validateRoles` reads (ADR-0019). */
  rules: RuleSet;
  now?: () => number;
  createMemberStore: (rules: RuleSet, clock?: () => number) => MemberStore;
}

/**
 * Wrap a `MemberStore` so every mutation is followed by a synchronous
 * snapshot write — members and spent invitation ids share ONE snapshot, so
 * one write keeps both consistent with each other by construction (no
 * window where one persisted and the other did not). Presence is
 * intentionally not part of this — see the module comment.
 */
export function createHubState(init: CreateHubStateInit): PersistentHub {
  const now = init.now ?? Date.now;
  const snapshot = init.store.read();

  const innerMembers = init.createMemberStore(init.rules, now);
  for (const m of snapshot.members) innerMembers.add(m.peerId, m.roles);
  const spentIds = new Set(snapshot.spentInvitationIds);

  const save = (): void => {
    init.store.write({
      members: innerMembers.list(),
      spentInvitationIds: [...spentIds],
    });
  };

  const memberStore: MemberStore = {
    add(peerId, roles) {
      const record = innerMembers.add(peerId, roles);
      save();
      return record;
    },
    setRoles(peerId, roles) {
      const record = innerMembers.setRoles(peerId, roles);
      save();
      return record;
    },
    remove(peerId) {
      innerMembers.remove(peerId);
      save();
    },
    get: innerMembers.get,
    list: innerMembers.list,
  };

  const pending = new Map<string, InvitationRecord>();

  const invitations: InvitationStore = {
    create(id, roles, ttlMs) {
      assertValid(validateRoles(init.rules, roles, `invitation '${id}'`));
      const record: InvitationRecord = { id, roles: [...roles], expiresAt: now() + ttlMs };
      pending.set(id, record);
      return record;
    },
    redeem(id) {
      // The spent check runs FIRST, and unconditionally — before the
      // invitation record is even looked up. That is what makes double
      // redemption impossible across a restart: the record itself is not
      // persisted, but the fact that this id was already spent is.
      if (spentIds.has(id)) return { ok: false, reason: "already-redeemed" };
      const record = pending.get(id);
      if (record == null) return { ok: false, reason: "not-found" };
      if (record.expiresAt <= now()) return { ok: false, reason: "expired" };
      pending.delete(id);
      spentIds.add(id);
      save();
      return { ok: true, roles: record.roles };
    },
  };

  return { memberStore, invitations };
}
