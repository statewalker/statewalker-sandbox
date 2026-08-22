/**
 * The NODE half of the hub's durable state: one JSON file, written
 * synchronously on every change.
 *
 * THE STORAGE-AGNOSTIC HALF LIVES IN `./hub-state.ts` — `SnapshotStore`,
 * `InvitationStore`, and `createHubState`, which is the whole of the hub's
 * state logic and knows about no storage at all. It moved there in Task 24
 * because the `SnapshotStore` seam is only as portable as the module that
 * declares it, and THIS module imports `node:fs`/`node:path` at module
 * scope: a browser bundle reaching the seam through here dragged both in
 * (Vite substitutes a stub that throws on first access, so the failure
 * lands at runtime in a tab, naming `node:fs` and nothing about the hub).
 * Everything that file declares is re-exported below, so this module's API
 * is exactly what it was — no existing caller or test sees a difference.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemberStore, RuleSet } from "@statewalker/httpeers.core";
import type { HubSnapshot, PersistentHub, SnapshotStore } from "./hub-state.js";
import { createHubState, EMPTY_SNAPSHOT } from "./hub-state.js";

export type {
  HubSnapshot,
  InvitationRecord,
  InvitationRedemption,
  InvitationStore,
  PersistentHub,
  SnapshotStore,
} from "./hub-state.js";
export { createHubState, EMPTY_SNAPSHOT } from "./hub-state.js";

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

/** The Node store: one JSON file, the behaviour every existing caller already had. */
export function createFileSnapshotStore(filePath: string): SnapshotStore {
  return {
    read: () => readSnapshot(filePath),
    write: (snapshot) => writeSnapshot(filePath, snapshot),
  };
}

export interface CreatePersistentHubInit {
  /** The Node path. Exactly one of `filePath` or `store` is required; `store` wins if both are given. */
  filePath?: string;
  /** Any other backing store -- a browser page passes one of these instead of a path. */
  store?: SnapshotStore;
  rules: RuleSet;
  now?: () => number;
  createMemberStore: (rules: RuleSet, clock?: () => number) => MemberStore;
}

/**
 * Build the hub's persistent state (members + spent invitation ids) over
 * one snapshot FILE, or over any other `SnapshotStore` the caller supplies.
 * The state logic itself is `./hub-state.ts`'s `createHubState`; this
 * function is that, plus "a path is a store too".
 *
 * A browser page has no path to give and calls `createHubState` directly
 * with its own store — it never reaches this module at all, which is the
 * point of the split (see the module comment).
 */
export function createPersistentHub(init: CreatePersistentHubInit): PersistentHub {
  const store =
    init.store ??
    (init.filePath != null
      ? createFileSnapshotStore(init.filePath)
      : (() => {
          // Loud at construction rather than a hub that comes up and silently
          // forgets every member on restart.
          throw new Error("createPersistentHub: pass either `filePath` or `store`");
        })());

  return createHubState({
    store,
    rules: init.rules,
    now: init.now,
    createMemberStore: init.createMemberStore,
  });
}
