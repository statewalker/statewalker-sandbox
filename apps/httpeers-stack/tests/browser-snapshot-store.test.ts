/**
 * `createIdbSnapshotStore` (`src/browser/snapshot-store.ts`) -- the browser
 * `SnapshotStore` the hub page runs on.
 *
 * NODE-TESTABLE BECAUSE THE STORAGE IS INJECTED, and that seam exists for
 * exactly this. Everything this store actually decides -- that the
 * in-memory copy is authoritative, that flushes are serialised and
 * coalesced, what a corrupt stored value means -- is storage-independent.
 * `idb-keyval` needs a real IndexedDB that Node does not have; a fake
 * `AsyncKeyValueBackend` needs nothing, and lets these tests assert the
 * ORDERING properties that matter (a slow earlier write must never land on
 * top of a later one) by controlling exactly when each put resolves, which
 * a real IndexedDB would not let them do at all.
 *
 * WHAT IS *NOT* COVERED HERE, stated rather than skipped: `idbBackend()`
 * itself -- three one-line delegations to `idb-keyval` -- and the fact that
 * IndexedDB survives a reload. Both need a browser; see this task's report.
 */
import { describe, expect, it } from "vitest";
import type { AsyncKeyValueBackend } from "../src/browser/snapshot-store.js";
import { createIdbSnapshotStore } from "../src/browser/snapshot-store.js";
import type { HubSnapshot } from "../src/hub/hub-state.js";

const KEY = "test:snapshot";

function snapshot(peerIds: string[], spent: string[] = []): HubSnapshot {
  return {
    members: peerIds.map((peerId) => ({ peerId, roles: ["member"], updatedAt: 1 })),
    spentInvitationIds: spent,
  };
}

/**
 * A backend that records every call and can HANG the next `set`
 * indefinitely, until the test releases it.
 *
 * The hang is the point. A store that fired each write's put independently
 * would let a later put complete while an earlier one was still in flight,
 * and then be overwritten by it when it finally landed. Nothing short of
 * holding one put open past a later one proves that cannot happen here --
 * a fast fake would let a racing implementation pass by accident.
 */
function fakeBackend(initial?: string) {
  const values = new Map<string, string>();
  if (initial != null) values.set(KEY, initial);
  /** Every completed write, in the order it actually landed in storage. */
  const landed: string[] = [];
  const calls: string[] = [];
  let hangNext: Promise<void> | null = null;

  const backend: AsyncKeyValueBackend = {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      calls.push("set");
      if (hangNext != null) {
        const held = hangNext;
        hangNext = null;
        await held;
      }
      values.set(key, value);
      landed.push(value);
    },
    del: async (key) => {
      calls.push("del");
      values.delete(key);
      landed.push("<deleted>");
    },
  };

  return {
    backend,
    values,
    landed,
    calls,
    /** Hang the next `set` until the returned function is called. */
    hangNextSet(): () => void {
      let release!: () => void;
      hangNext = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

describe("createIdbSnapshotStore", () => {
  it("reads an empty snapshot on a first run, when storage holds nothing", async () => {
    const fake = fakeBackend();
    const store = await createIdbSnapshotStore({ backend: fake.backend, storageKey: KEY });

    expect(store.read()).toEqual({ members: [], spentInvitationIds: [] });
  });

  it("reads back what a previous session stored", async () => {
    const stored = snapshot(["12D3KooPrevious"], ["inv-1"]);
    const fake = fakeBackend(JSON.stringify(stored));
    const store = await createIdbSnapshotStore({ backend: fake.backend, storageKey: KEY });

    expect(store.read()).toEqual(stored);
  });

  it("read-after-write is synchronous -- the whole point of the contract", async () => {
    const fake = fakeBackend();
    const store = await createIdbSnapshotStore({ backend: fake.backend, storageKey: KEY });

    const next = snapshot(["12D3KooA"]);
    store.write(next);

    // Not awaited, not deferred: `createHubState` calls `write` and then
    // returns a `MemberRecord` to its caller. If `read` did not already
    // agree, the hub would have told a caller a member was added while its
    // own state still said otherwise.
    expect(store.read()).toEqual(next);
    // ...and storage has not necessarily caught up yet, which is fine.
    await store.flushed();
    expect(JSON.parse(fake.values.get(KEY)!)).toEqual(next);
  });

  it("coalesces a burst of writes into one put carrying the last value", async () => {
    const fake = fakeBackend();
    const store = await createIdbSnapshotStore({ backend: fake.backend, storageKey: KEY });

    store.write(snapshot(["a"]));
    store.write(snapshot(["a", "b"]));
    store.write(snapshot(["a", "b", "c"]));
    await store.flushed();

    // One put, not three -- and it carries the LAST value, not the first.
    expect(fake.calls).toEqual(["set"]);
    expect(JSON.parse(fake.values.get(KEY)!).members).toHaveLength(3);
  });

  it("serialises flushes, so a slow earlier put cannot land on top of a later one", async () => {
    const fake = fakeBackend();
    const store = await createIdbSnapshotStore({ backend: fake.backend, storageKey: KEY });

    // Hang the first put. An implementation that fired puts independently
    // (`void backend.set(...)` per write) would let the SECOND one complete
    // while this one is stuck, and then be overwritten by it on release --
    // which, for `spentInvitationIds`, resurrects a spent invitation id and
    // is a membership bypass, not a cosmetic ordering wobble.
    const release = fake.hangNextSet();

    store.write(snapshot(["a"], ["inv-1"]));
    // Let the hung put begin, then write again while it is still stuck.
    await Promise.resolve();
    store.write(snapshot(["a", "b"], ["inv-1", "inv-2"]));
    // Give a racing implementation every chance to land its second put.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.landed).toEqual([]);

    release();
    await store.flushed();

    const final = JSON.parse(fake.values.get(KEY)!) as HubSnapshot;
    expect(final.spentInvitationIds).toEqual(["inv-1", "inv-2"]);
    // The last thing to land is the last value written, whatever order the
    // puts began in.
    expect(fake.landed.at(-1)).toBe(JSON.stringify(snapshot(["a", "b"], ["inv-1", "inv-2"])));
  });

  it("starts from an empty snapshot when the stored value is not readable JSON", async () => {
    const fake = fakeBackend("{not json at all");
    const store = await createIdbSnapshotStore({ backend: fake.backend, storageKey: KEY });

    // Deliberately not a throw: a page that refused to start would also
    // refuse to render its own reset control, leaving nothing to do but
    // clear site data by hand. See the function's own doc comment.
    expect(store.read()).toEqual({ members: [], spentInvitationIds: [] });
  });

  it("tolerates a stored value missing either field", async () => {
    const fake = fakeBackend(
      JSON.stringify({ members: [{ peerId: "x", roles: [], updatedAt: 0 }] }),
    );
    const store = await createIdbSnapshotStore({ backend: fake.backend, storageKey: KEY });

    expect(store.read().spentInvitationIds).toEqual([]);
    expect(store.read().members).toHaveLength(1);
  });

  it("clear() empties both the in-memory copy and storage", async () => {
    const fake = fakeBackend(JSON.stringify(snapshot(["a"], ["inv-1"])));
    const store = await createIdbSnapshotStore({ backend: fake.backend, storageKey: KEY });

    await store.clear();

    expect(store.read()).toEqual({ members: [], spentInvitationIds: [] });
    expect(fake.values.has(KEY)).toBe(false);
  });

  it("clear() queues behind an in-flight flush rather than racing it", async () => {
    const fake = fakeBackend();
    const store = await createIdbSnapshotStore({ backend: fake.backend, storageKey: KEY });

    const release = fake.hangNextSet();
    store.write(snapshot(["a"]));
    await Promise.resolve();
    const cleared = store.clear();
    release();
    await cleared;

    // The delete lands last, so the hung put cannot resurrect the snapshot
    // after the reset control has already reported success.
    expect(fake.landed.at(-1)).toBe("<deleted>");
    expect(fake.values.has(KEY)).toBe(false);
  });

  it("a failing backend is reported, not rethrown into the hub's write path", async () => {
    const failing: AsyncKeyValueBackend = {
      get: async () => undefined,
      set: async () => {
        throw new Error("quota exceeded");
      },
      del: async () => {},
    };
    const store = await createIdbSnapshotStore({ backend: failing, storageKey: KEY });

    store.write(snapshot(["a"]));
    // `flushed()` must resolve, never reject: the chain is shared, so a
    // rejection left on it would be reported again by every later caller.
    await expect(store.flushed()).resolves.toBeUndefined();
    // And the in-memory copy -- the authoritative one -- is unaffected.
    expect(store.read().members).toHaveLength(1);
  });
});
