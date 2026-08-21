/**
 * The BROWSER `SnapshotStore` (`../hub/hub-state.ts`): the hub page's
 * members and spent invitation ids, kept in IndexedDB.
 *
 * THE WHOLE DIFFICULTY IS THAT `write` IS SYNCHRONOUS AND INDEXEDDB IS NOT.
 * `SnapshotStore.write`'s contract is explicit that it must stay
 * synchronous -- `createHubState` calls it and returns, so an async store
 * would open a window where a caller has been told a member was added while
 * the snapshot still says otherwise. Making the method `async` is therefore
 * not an option, and neither is waiting inside it: there is no way to block
 * on a promise in a browser.
 *
 * SO THE IN-MEMORY COPY IS AUTHORITATIVE AND INDEXEDDB TRAILS IT. `write`
 * replaces `current` and returns immediately; the flush runs behind it.
 * `read` answers from `current`, never from storage -- so the hub always
 * sees exactly what it last wrote, whatever IndexedDB is doing. Storage is
 * consulted exactly once, at construction (`createIdbSnapshotStore` is
 * async for that reason and that reason only), which is also the only
 * moment `createHubState` needs it.
 *
 * FLUSHES ARE SERIALISED AND COALESCED, on one promise chain. Two
 * consequences worth stating, because both are load-bearing:
 *   - Serialised: writes reach IndexedDB in the order they were made, so a
 *     slow earlier put can never land ON TOP OF a later one and resurrect
 *     a spent invitation id. An unordered `void put(...)` per write would
 *     make that a genuine (if rare) membership bypass.
 *   - Coalesced: the chain always flushes the LATEST `current`, not the
 *     value that was current when the write happened. A burst of joins
 *     costs one or two puts, not one per member, and the final state is
 *     identical either way.
 *
 * WHAT SURVIVES A CRASH, HONESTLY STATED. A tab closed between a `write`
 * and its flush loses that write -- this is a page, not a database, and
 * there is no synchronous storage in a browser that could do better (
 * `localStorage` is synchronous but caps out around 5 MB and blocks the
 * main thread; neither trade is worth making for state that is rebuilt by
 * re-issuing an invitation). `flushed()` exists for the caller that CAN
 * wait -- a reset control, a test -- and nothing on the hot path awaits it.
 *
 * THE VALUE IS STORED AS A JSON STRING, not as a structured-cloned object.
 * That makes this store's round trip byte-identical in semantics to the
 * Node file store's (`../hub/persist.ts`: `JSON.stringify` out,
 * `JSON.parse` in) -- same handling of `undefined`, no way for a `Date` or
 * a `Map` to survive here and not there -- and it sidesteps
 * `DataCloneError` on any value a future `HubSnapshot` field might hold.
 */
import type { HubSnapshot, SnapshotStore } from "../hub/hub-state.js";
import { EMPTY_SNAPSHOT } from "../hub/hub-state.js";
import type { AsyncKeyValueBackend } from "./kv.js";
import { idbBackend } from "./kv.js";

/**
 * The asynchronous key/value storage this store writes through.
 *
 * INJECTED SO THIS MODULE'S LOGIC IS NODE-TESTABLE. Everything this module
 * actually decides -- authoritative in-memory copy, serialised flushes,
 * coalescing, what a corrupt stored value means -- is storage-independent,
 * and `idb-keyval` needs a real IndexedDB that Node does not have. The seam
 * keeps the browser-only part down to `idbBackend()`, which is three
 * one-line delegations, and lets `tests/browser-snapshot-store.test.ts`
 * exercise the rest for real instead of skipping it.
 *
 * BOTH NAMES LIVE IN `./kv.ts` NOW and are re-exported here unchanged --
 * three modules want this seam and only one of them is a hub. A caller that
 * imports either name from here keeps working.
 */
export { type AsyncKeyValueBackend, idbBackend } from "./kv.js";

/** Where the hub page's snapshot lives in IndexedDB, beside `./identity.ts`'s key and namespaced the same way. */
export const HUB_SNAPSHOT_STORAGE_KEY = "httpeers:hub-snapshot";

export interface BrowserSnapshotStore extends SnapshotStore {
  /**
   * Resolves once every `write` made so far has actually reached storage.
   * For a caller that can wait and needs to know -- the reset control, and
   * the tests. Never awaited on the hub's own write path; see the module
   * comment.
   */
  flushed(): Promise<void>;
  /**
   * Erase the stored snapshot AND the in-memory copy, leaving this store as
   * it was on a first run. Used by the hub page's reset control, which
   * destroys the identity in the same breath -- members carried into a
   * newly-founded mesh would be peers that never joined it.
   */
  clear(): Promise<void>;
}

/**
 * Parse a stored snapshot, tolerating both "nothing stored yet" (a first
 * run) and a value that is not a snapshot at all.
 *
 * A CORRUPT VALUE IS NOT FATAL HERE, unlike in the Node store, and the
 * asymmetry is deliberate. `../hub/persist.ts`'s `readSnapshot` rethrows
 * anything that is not `ENOENT`, because a Node hub that cannot read its
 * state file should stop and let an operator look at it -- there is an
 * operator, and there is a file to look at. A page has neither: throwing
 * here would leave a hub page that cannot start AND cannot reach its own
 * reset control, with nothing to do but clear site data by hand. Starting
 * empty and saying so on the console is recoverable; the operator re-issues
 * invitations, which is the same cost as a genuinely fresh page.
 */
function parseSnapshot(raw: string | undefined): HubSnapshot {
  if (raw == null) return EMPTY_SNAPSHOT;
  try {
    const parsed = JSON.parse(raw) as Partial<HubSnapshot>;
    return {
      members: parsed.members ?? [],
      spentInvitationIds: parsed.spentInvitationIds ?? [],
    };
  } catch (err) {
    console.error(
      `snapshot-store: the stored snapshot at "${HUB_SNAPSHOT_STORAGE_KEY}" is not readable ` +
        "JSON -- starting from an empty one. Members will have to rejoin and invitations be " +
        "re-issued; every previously spent invitation id is forgotten with it.",
      err,
    );
    return EMPTY_SNAPSHOT;
  }
}

export interface CreateIdbSnapshotStoreInit {
  /** Defaults to `idbBackend()` -- the real IndexedDB. Overridden by tests. */
  backend?: AsyncKeyValueBackend;
  /** Defaults to `HUB_SNAPSHOT_STORAGE_KEY`. */
  storageKey?: string;
}

/**
 * Read the stored snapshot once and return a `SnapshotStore` over it. The
 * only asynchronous step in this module's whole life; see the module
 * comment.
 */
export async function createIdbSnapshotStore(
  init: CreateIdbSnapshotStoreInit = {},
): Promise<BrowserSnapshotStore> {
  const backend = init.backend ?? idbBackend();
  const storageKey = init.storageKey ?? HUB_SNAPSHOT_STORAGE_KEY;

  let current = parseSnapshot(await backend.get(storageKey));

  // The single chain every flush and every `clear` joins. `pending` is the
  // tail; `flushScheduled` is what makes a burst of writes cost one put
  // instead of one per write -- see "FLUSHES ARE SERIALISED AND COALESCED".
  let pending: Promise<void> = Promise.resolve();
  let flushScheduled = false;

  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    pending = pending.then(async () => {
      flushScheduled = false;
      // Reads `current` HERE, at flush time -- that is the coalescing: every
      // write made while this flush was queued is already folded into it.
      await backend.set(storageKey, JSON.stringify(current));
    });
    // The chain must never end rejected, or every later `flushed()` would
    // report a failure that has already been surfaced. Logged and swallowed
    // here; the in-memory copy is unaffected and the hub keeps working.
    pending = pending.catch((err: unknown) => {
      console.error(
        `snapshot-store: could not persist the hub snapshot to "${storageKey}". The hub is ` +
          "still correct in this tab; a reload would lose everything written since the last " +
          "successful write.",
        err,
      );
    });
  };

  return {
    read: () => current,
    write(snapshot) {
      current = snapshot;
      scheduleFlush();
    },
    flushed: () => pending,
    async clear() {
      current = EMPTY_SNAPSHOT;
      // Queued on the SAME chain, so it cannot race ahead of a flush that is
      // already in flight and be immediately overwritten by it.
      pending = pending.then(() => backend.del(storageKey));
      await pending;
    },
  };
}
