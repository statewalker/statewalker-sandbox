/**
 * The hub's durable state: members and spent invitation ids, snapshotted to
 * one JSON file, written synchronously on every change.
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemberRecord, MemberStore, Vocabulary } from "@statewalker/httpeers.core";
import { assertValid, validateRoles } from "@statewalker/httpeers.core";

export interface HubSnapshot {
  members: MemberRecord[];
  spentInvitationIds: string[];
}

const EMPTY_SNAPSHOT: HubSnapshot = { members: [], spentInvitationIds: [] };

/** Tolerant of a missing file (first run) — anything else is a real failure, not silently swallowed. */
export function readSnapshot(filePath: string): HubSnapshot {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_SNAPSHOT;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<HubSnapshot>;
  return {
    members: parsed.members ?? [],
    spentInvitationIds: parsed.spentInvitationIds ?? [],
  };
}

export function writeSnapshot(filePath: string, snapshot: HubSnapshot): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
}

/**
 * Wraps a `MemberStore` so every mutation is followed by a synchronous
 * snapshot write — members and spent invitation ids share one file, so one
 * write keeps both consistent with each other by construction (no window
 * where one persisted and the other did not).
 */
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
  /** Throws (via `assertValid`) if any role is not in the vocabulary — caught where the invitation is made, not three hops later. */
  create(id: string, roles: string[], ttlMs: number): InvitationRecord;
  redeem(id: string): InvitationRedemption;
}

/**
 * Build the hub's persistent state (members + spent invitation ids) over one
 * snapshot file, loading it at construction and writing it back after every
 * mutation. Presence is intentionally not part of this — see the module
 * comment.
 */
export function createPersistentHub(init: {
  filePath: string;
  vocabulary: Vocabulary;
  now?: () => number;
  createMemberStore: (clock?: () => number) => MemberStore;
}): PersistentHub {
  const now = init.now ?? Date.now;
  const snapshot = readSnapshot(init.filePath);

  const innerMembers = init.createMemberStore(now);
  for (const m of snapshot.members) innerMembers.add(m.peerId, m.roles);
  const spentIds = new Set(snapshot.spentInvitationIds);

  const save = (): void => {
    writeSnapshot(init.filePath, {
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
      assertValid(validateRoles(init.vocabulary, roles, `invitation '${id}'`));
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
