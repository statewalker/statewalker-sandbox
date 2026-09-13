/**
 * 04 — Does hub state survive a restart over a FilesApi adapter, and what
 * breaks with two writers?
 *
 * The hub state is the real one: `hub/hub-state.ts`'s `createHubState` over
 * `httpeers.core`'s `createMemberStore`, with only the `SnapshotStore`
 * swapped for the candidate adapter. "Restart" means building a second
 * `createHubState` over the same storage, which is exactly what a hub process
 * or a reloaded hub tab does.
 */

import { createMemberStore } from "@statewalker/httpeers.core";
import { createHubState } from "@statewalker/httpeers-stack/src/hub/hub-state.js";
import { appRules } from "@statewalker/httpeers-stack/src/policy.js";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { asyncSnapshotStore, filesStorage, memoryStorage } from "../src/storage.js";

const RULES = appRules([]);
const ALICE = "12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ";
const BOB = "12D3KooWEHUcCvsmTLLoQG28Y2PDkUfddP1WmdSKwY1sSxfANcxR";

async function openHub(storage: Awaited<ReturnType<typeof memoryStorage>>) {
  const store = await asyncSnapshotStore(storage);
  const hub = createHubState({ store, rules: RULES, createMemberStore });
  return { hub, store };
}

describe("04 — hub storage", () => {
  it("CLAIM 1 — members survive a restart through a FilesApi adapter", async () => {
    const files = new MemFilesApi();
    const storage = filesStorage(files);

    const first = await openHub(storage);
    first.hub.memberStore.add(ALICE, ["member"]);
    await first.store.flushed();

    // A new process over the same files: nothing is carried across in memory.
    const second = await openHub(storage);
    expect(second.hub.memberStore.list().map((m) => m.peerId)).toEqual([ALICE]);
    expect(second.hub.memberStore.get(ALICE)?.roles).toEqual(["member"]);
  });

  it("CLAIM 2 — a spent invitation stays spent across a restart, so single-use survives", async () => {
    const files = new MemFilesApi();
    const storage = filesStorage(files);

    const first = await openHub(storage);
    first.hub.invitations.create("inv-1", ["member"], 600_000);
    expect(first.hub.invitations.redeem("inv-1")).toMatchObject({ ok: true });
    await first.store.flushed();

    const second = await openHub(storage);
    // The pending record is gone with the process, but the SPENT id is the
    // half that must persist: a restart must not make a used invitation
    // usable again.
    expect(second.hub.invitations.redeem("inv-1")).toMatchObject({
      ok: false,
      reason: "already-redeemed",
    });
  });

  it("CLAIM 3 — an UNREDEEMED invitation does not survive a restart (it is memory-only)", async () => {
    const files = new MemFilesApi();
    const storage = filesStorage(files);

    const first = await openHub(storage);
    first.hub.invitations.create("inv-2", ["member"], 600_000);
    await first.store.flushed();

    const second = await openHub(storage);
    // Not a defect of the adapter: `hub-state.ts` keeps pending invitations in
    // a Map and persists only the spent ids. Recorded because it is a real
    // behaviour of the code being extracted — every invitation handed out and
    // not yet redeemed dies with the hub, and the guest sees "not-found".
    expect(second.hub.invitations.redeem("inv-2")).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });

  it("CLAIM 4 — TWO WRITERS CLOBBER EACH OTHER: last writer wins, silently", async () => {
    const files = new MemFilesApi();
    const storage = filesStorage(files);

    // Two hubs over one store — two tabs on one origin, or two processes on
    // one directory. Both loaded the same (empty) snapshot.
    const tabA = await openHub(storage);
    const tabB = await openHub(storage);

    tabA.hub.memberStore.add(ALICE, ["member"]);
    tabB.hub.memberStore.add(BOB, ["member"]);
    await tabA.store.flushed();
    await tabB.store.flushed();

    const reopened = await openHub(storage);
    const peers = reopened.hub.memberStore.list().map((m) => m.peerId);

    // ONE of them is gone, and nothing reported an error. This is the
    // single-writer precondition made visible: FilesApi has no conditional
    // write, so the adapter CANNOT detect the conflict — the fix is a lock
    // (a Web Lock in a tab, a lockfile in a process), not a richer interface.
    expect(peers).toHaveLength(1);
    expect(peers).toEqual([BOB]);
  });

  it("CLAIM 5 — the same hub state runs unchanged over a memory adapter", async () => {
    const storage = memoryStorage();
    const first = await openHub(storage);
    first.hub.memberStore.add(ALICE, ["member"]);
    await first.store.flushed();

    const second = await openHub(storage);
    expect(second.hub.memberStore.list().map((m) => m.peerId)).toEqual([ALICE]);
  });

  it("CLAIM 6 — a corrupt stored value starts empty rather than refusing to start", async () => {
    const storage = memoryStorage();
    await storage.set("snapshot", "{ this is not json");
    const { hub } = await openHub(storage);
    expect(hub.memberStore.list()).toEqual([]);
  });
});
