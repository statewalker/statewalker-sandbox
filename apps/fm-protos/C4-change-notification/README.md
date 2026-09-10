# C4-change-notification — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/C4-change-notification/`._

---

<!-- source: 01-C4 rung record and code.md -->

# C4 — Change notification · rung record

_9 September 2026 · green: 156/156 (14 new) · mutations killed: 8/8 (one after strengthening)_

## Verdict

Tier one ships and behaves: operations are the authoritative source, deliveries
are coalesced, and fan-out is prefix- and storage-scoped. Promotion grade:
**Adopt**.

## Shape

`ChangeNotifier` lives in `fm-core` and knows nothing about panels. It accepts
`{ storageUri, path, jobId?, kind }`, coalesces everything raised in a tick into
**one** delivery on a microtask, and hands the batch to listeners.
`PanelController.subscribe(notifier)` filters by storage and by prefix, marks
the affected rows, and re-lists once.

Three tiers, of which only the first ships — there is no `watch()` anywhere in
`FilesApi`, so this is not a limitation to design around later, it is the
permanent shape. `registry.canWatch()` returns false for everything, and the
test asserts it: the hook exists, nothing implements it.

## Batching is the whole point

`notify()` is synchronous and undifferentiated, so a job completing 500 entries
must not pulse 500 times — a subscribed panel would re-list 500 times for one
logical change. Two tests pin it: 500 events arrive as **one delivery of 500
events**, and a panel watching that directory performs exactly **one** listing.

Removing the coalescing fails two tests; replaying the batch instead of draining
it fails one.

## `isUnder`, not `startsWith`

The naive prefix check matches `/dir2/a.txt` against `/dir`. `isUnder` is
directory-aware: equal paths match, children match with a separator, and `/`
matches everything. M2 (revert to `startsWith`) dies.

## Marks are transient by design

A change marks the affected rows with the originating job — `{ jobId, kind }`
keyed by path — and the **listing that reflects it clears them**. This is the
weaker per-row marking that ships in v1, ahead of full optimistic phantom rows.

The first version of the mark test raced the refresh and failed: against mem
storage the re-listing completes in the same tick, so by the time the assertion
ran the marks were already (correctly) gone. The test now records snapshots from
`onUpdate` and asserts one of them carried the mark — observing the
notification rather than racing it. Worth remembering for D2: anything whose
lifetime is "until the next listing" cannot be asserted by reading state after
an await.

## Polling is opt-in and observer-bound

`pollMs` defaults to 0 per storage, and a poll starts only when a directory is
actually observed — a background poll of a remote bucket nobody is looking at is
cost with no reader. Polling stops when the **last** observer of that storage
leaves, not the first (M7).

## The mutation that survived

M3 — drop the storage check from fan-out — survived, because the test compared
`lastListedAt` before and after, and **two listings inside one millisecond leave
the timestamp unchanged**. `Date.now()` is not a fine enough instrument to prove
a listing did not happen.

Both tests that asserted "no re-listing" now count listings through a new
`onListed()` hook instead. Same lesson as C3/M8 in a different costume: assert
the event, not a proxy for it.

## Acceptance criteria, as tested

Prefix matching: `/dir/a.txt`, `/dir`, `/dir/sub/deep.txt` are under `/dir`;
`/dir2/a.txt` is not; everything is under `/`.

Batching: 500 events → one delivery, 500 events carried; a later change forms a
new batch rather than replaying the first; `jobId` reaches the listener.

Fan-out: only panels whose cwd contains the change re-list; a change on a
different storage at the same path is ignored (**counted**, not timed); 500
changes in one directory cost one listing; rows are marked by originating job
and cleared by the listing; a disposed controller stops re-listing.

Polling: off by default; runs only while a directory is observed; survives one
observer of several leaving; `canWatch()` is false everywhere.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | no coalescing (one delivery per event) | 2 |
| M2 | prefix match is a naive `startsWith` | 1 |
| M3 | storage ignored in fan-out | 1 (after counting instead of timing) |
| M4 | `jobId` dropped from the event | 1 |
| M5 | marks never cleared by the listing | 1 |
| M6 | polling starts regardless of `pollMs` | 1 |
| M7 | polling stops when any observer leaves | 1 |
| M8 | batch replayed instead of drained | 1 |

## Code

```ts
/**
 * C4 — freshness comes from OPERATIONS first.
 *
 * There is no `watch()` anywhere in `FilesApi`, so this is not a limitation to
 * design around later: it is the permanent shape. Three tiers, of which only
 * the first ships — operations (authoritative, always available), optional
 * per-storage polling (default OFF, and only for directories someone is
 * actually looking at), and an adapter watcher hook that stays unimplemented.
 *
 * Events are COALESCED into one delivery per tick. `notify()` is synchronous
 * and undifferentiated, so a job completing 500 entries must not pulse 500
 * times — the listener would re-list 500 times for one logical change.
 */
```

```ts
/** True when `path` is at or below `prefix`. Directory-aware, not string-naive. */
export function isUnder(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}
```

```ts
  private _onChanges(batch: ChangeEvent[]): void {
    const mine = batch.filter(
      (event) => event.storageUri === this.model.storage && isUnder(event.path, this.model.path),
    );
    if (mine.length === 0) return;

    // Mark first, re-list second: the user sees the rows in question flagged
    // immediately, and the marks clear when the listing that reflects them
    // arrives.
    const marks = { ...this.model.marks };
    for (const event of mine) marks[event.path] = { jobId: event.jobId, kind: event.kind };
    this.model.marks = marks;
    this.model.notify();

    this._track(this.refresh());
  }
```

```ts
  /**
   * Polling is opt-in per storage and only covers directories with a live
   * observer: a background poll of a remote bucket nobody is looking at is
   * cost with no reader.
   */
  observe(storageUri: string, path: string, onTick: () => void): () => void { … }
```

## Deliberately not done

Cross-tab notification via `BroadcastChannel` remains stage two, gated on
staying contained to one file, with the cross-tab lock after it. Nothing in this
rung presumes single-tab operation beyond that.

## Next

**C5 — command surface and override**: the whole `files:*` namespace at negative
priority, `files:resolve-actions`, `CommandError.kind` discipline, the registry's
runtime `onUpdate`, and the agent-tool projection.

