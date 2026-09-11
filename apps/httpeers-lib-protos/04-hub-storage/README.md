# 04 — Does hub state survive a restart over a FilesApi adapter, and what breaks with two writers?

`pnpm test 04-hub-storage`

**Answer: it survives, three methods are enough, and two writers silently lose
one writer's work.** The conclusion for the library: keep the interface at
`get`/`set`/`delete` and make single-writer an enforced precondition, not a
richer storage contract.

The hub state is the real one — `hub/hub-state.ts`'s `createHubState` over
`httpeers.core`'s `createMemberStore` — with only the `SnapshotStore` swapped.
A "restart" is a second `createHubState` over the same storage, which is what
a restarted process or a reloaded hub tab actually does.

## Verified

| # | Claim | Why it matters |
|---|---|---|
| 1 | Members survive a restart over a FilesApi adapter | The durable half of membership works through the seam |
| 2 | A spent invitation is **still spent** after a restart | Single-use is the security property; losing it would let a used invitation back in |
| 3 | An **unredeemed** invitation does **not** survive | Pending invitations are memory-only in `hub-state.ts`; every invitation handed out and not yet redeemed dies with the hub, and the guest sees `not-found` |
| 4 | Two writers clobber each other — last writer wins, **silently** | The single-writer precondition, made visible |
| 5 | The same state runs unchanged over a memory adapter | The seam is not FilesApi-shaped |
| 6 | A corrupt stored value starts empty instead of refusing to start | A truncated state file must not brick a hub |

Measured 2026-09-12, all six pass, 4 ms.

## What the adapter interface is, and why it is only three methods

Everything the hub does to storage today is whole-value get / set / delete by
key: `persist.ts` reads and writes one JSON file, `browser/snapshot-store.ts`
reads and writes one IndexedDB value. Nothing lists, appends or compare-and-sets.

```ts
interface KeyValueStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

`SnapshotStore` stays **synchronous** (`read()`/`write()`), because every hub
mutation writes and returns; an async write would let a caller be told "member
added" while the snapshot still said otherwise. So any async backend needs the
wrapper the browser already has — in-memory copy authoritative, flushes
serialised behind it — which `asyncSnapshotStore` generalises to any backend.

## Two things worth fixing during extraction

**The Node file store is not crash-safe.** `persist.ts` writes in place, so a
crash mid-write can leave a half-written snapshot where the whole state lives.
The FilesApi adapter here writes to a temp path and `move`s, and the extracted
package should do that on every backend.

**Claim 4 is not fixable in the interface.** FilesApi has no conditional write
— no compare-and-set, no if-match — so the adapter cannot even detect the
conflict. Two hub tabs on one origin are the realistic case, and the remedy is
a lock (a Web Lock in a tab, a lockfile in a process) plus a documented
precondition. Adding compare-and-set to the storage interface would buy nothing
the hub currently uses and would exclude FilesApi as a backend.

## Not covered

- **IndexedDB**, which needs a browser. It is the same three methods, and the
  stack already proves that backend in the hub page; nothing here re-tests it.
- **A real filesystem.** `MemFilesApi` stands in for FilesApi, so this exercises
  the adapter's shape, not disk behaviour or fsync.
- **Presence, advertisements and revocations**, which are memory-only by design
  and out of the snapshot entirely.
- **The locking remedy itself.** Claim 4 measures the damage; it does not
  implement or test a Web Lock.
- **Concurrent writes *within* one hub**, which the serialised chain handles and
  no test here perturbs.
