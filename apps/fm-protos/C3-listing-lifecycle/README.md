# C3-listing-lifecycle — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/C3-listing-lifecycle/`._

---

<!-- source: 01-C3 rung record and code.md -->

# C3 — Listing lifecycle · rung record

_9 September 2026 · green: 142/142 (18 new) · mutations killed: 8/8 (one after strengthening)_

## Verdict

The failure matrix from file 08 holds exactly as written, and the three states
it distinguishes are now three different observable outcomes rather than three
paragraphs. Promotion grade: **Adopt**.

## The failure matrix, as implemented

One loader, `_load(path, mode, pushHistory)`, with two failure policies:

| Failure | `entries` | `stale` | `path` |
| --- | --- | --- | --- |
| **Refresh** fails | kept | `true` | unchanged |
| **Navigation** fails | cleared | `false` | moves to the requested path |
| Partial buffer, either mode | **always discarded** | — | — |

A refresh that fails keeps what was true recently: the cursor and selection stay
meaningful and retry is one keystroke. A navigation that fails clears, because
showing the previous directory's contents under a new breadcrumb is a lie. And
the partial buffer is never promoted in either mode — a partial listing is
indistinguishable from a complete one, so "the file isn't there" becomes
ambiguous and "copy everything here" would silently copy a subset.

`canOperateOnListing()` returns false while `stale` or `error` is set, so the
view disables completeness-dependent operations without the controller
deciding per action.

## Two structural corrections

**The input reaction moved from `activate()` to the constructor.** It had been
registered alongside the command listeners, which meant a controller that was
never shown did not reconcile — a headless panel is a first-class case, not a
degenerate one. Only the command listeners and the `ui:show-panel` request
belong in `activate()`.

**`compareInfos` was missing from P1.** `compareEntries` orders
`{ name, stats }` rows, but `list()` yields flat `FileInfo` with `kind` and
`size` at the top level. Rather than let callers hand-roll the adaptation,
`fm-core` now exports a comparator over `FileInfo` that narrows internally — so
nobody can accidentally sort on a size a directory never had.

## Acceptance criteria, as tested

Navigation and history: navigate records history; back and forward work; the
forward branch is **truncated** on a new navigation, and the abandoned branch is
gone rather than merely out of reach; input-driven navigation reconciles through
`input`, never through the controller's own writes.

Sort and filter as **view state over one listing**: directories group first in
every column; a filter causes **no I/O** (`lastListedAt` unchanged, `entries`
intact); both survive a refresh. The substring filter is pinned as a substring —
`"a."` matches `zeta.txt` too, which is correct and easy to regress into a
prefix match.

Empty is not missing: `list()` returns an empty iterable for a path that does
not exist, so an empty result is disambiguated with `exists()`. An empty
directory reports `missing: false`; `/nope` reports `missing: true`.

Freshness is reported, not pretended: every successful listing stamps
`lastListedAt`; a failed one never does.

Model discipline (C1 kit): `entries` and `visible` are replaced, never mutated.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | partial buffer promoted on failure | 2 |
| M2 | failed refresh clears entries (navigation policy everywhere) | 2 |
| M3 | failed navigation keeps old entries (refresh policy everywhere) | 2 |
| M4 | `stale` never cleared on success | 1 |
| M5 | `missing` never distinguished from empty | 1 |
| M6 | failed listing stamps `lastListedAt` | 1 |
| M7 | filter triggers a re-list | 1 |
| M8 | forward branch not truncated | 1 (after strengthening) |

M8 first survived because "after back + navigate, `canGoForward()` is false"
holds whether or not the branch was truncated — the new entry lands at the end
either way. The test now walks **back** from the new leaf and asserts it returns
to where the user actually was, never to the path they navigated away from.
Third time the §2.6 rule has paid: assert the consequence, not the symptom.

## Code — the heart of it

```ts
  /**
   * One loader, two failure policies.
   *
   * A REFRESH that fails keeps the prior entries and marks them `stale`: the
   * content was true recently, the cursor and selection stay meaningful, and
   * retry is one keystroke. A NAVIGATION that fails clears them, because
   * showing the previous directory's contents under a new breadcrumb is a lie.
   *
   * In both cases the partial buffer is DISCARDED. A partial listing is
   * indistinguishable from a complete one, so "the file isn't there" becomes
   * ambiguous and "copy everything here" would silently copy a subset.
   */
  private async _load(path: string, mode: "navigate" | "refresh", pushHistory: boolean) {
    const buffer = [];
    try {
      for await (const entry of this._api.list(path)) {
        narrowStats(entry); // conformance at the boundary, per P1
        buffer.push(entry);
      }
    } catch (err) {
      if (mode === "refresh") {
        this.model.stale = true; // entries kept: true recently, not now
      } else {
        this.model.path = path;
        this.model.entries = [];
        this.model.stale = false;
        this._project();
      }
      this.model.error = String((err as Error).message ?? err);
      this.model.notify();
      return;
    }

    // `list()` returns an empty iterable for a path that does not exist, so an
    // empty listing has to be disambiguated before it is reported as empty.
    this.model.missing = buffer.length === 0 ? !(await this._api.exists(path)) : false;

    if (pushHistory && path !== this.model.path) {
      this._history = [...this._history.slice(0, this._historyAt + 1), path];
      this._historyAt = this._history.length - 1;
    }
    this.model.path = path;
    this.model.entries = buffer;
    this.model.stale = false;
    this.model.error = undefined;
    this.model.lastListedAt = Date.now();
    this._project();
  }
```

```ts
    const input = this.model.input;
    // Edges first, by delta against a watermark: two presses in one tick are
    // both real, and a boolean could express only one.
    if (input.navigateCount > this._handledNavigate) { … }
    if (input.refreshCount > this._handledRefresh) { … }
    if (input.backCount > this._handledBack) { … }
    if (input.forwardCount > this._handledForward) { … }
    // Levels: reconciled idempotently. No change, no work.
    if (input.sortColumn !== this._sort) this._track(this.setSort(input.sortColumn));
    if (input.filterText !== this._filter) this._track(this.setFilter(input.filterText));
```

```ts
// fm-core/file-stats.ts
/**
 * The same ordering over a raw `FileInfo` from `list()`, whose stats are flat
 * fields rather than a nested object. Narrowing happens here, so a caller
 * cannot accidentally sort on a size a directory never had.
 */
export function compareInfos(column: "name" | "size" | "date") { … }
```

## Next

**C4 — change notification**: operation-sourced invalidation carrying the job
id, prefix fan-out across panels, batched `notify()` so a 500-entry job does not
pulse 500 times, and per-row marking. Polling stays behind a per-storage
`pollMs` defaulting to off; the adapter watcher hook stays unimplemented.

