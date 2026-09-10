# D2a-model-driven-table — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/D2a-model-driven-table/`._

---

<!-- source: 01-D2a rung record and grid decision.md -->

# D2a — Model-driven table, and the grid-library decision · rung record

_10 September 2026 · green: 221 passed, 1 skipped (222) · 16 new · mutations killed: 7/7_

## The decision

**HighTable for the grid; not TanStack Table.** Both were evaluated against
one requirement: *the table visualisation must be driven by data — by a
dedicated model — and not own state of its own.*

### HighTable (`hightable@0.26.4`, MIT, 277★)

Its `DataFrame` is **pull-based**: `numRows`, `getCell({row, column, orderBy})`,
`getRowNumber({row})`, plus an `eventTarget` that dispatches `update`,
`resolve` and `numrowschange`. That is the same shape our models already have —
data behind an accessor, plus one notify channel. Virtualization is built in,
dependencies are **zero** (React is a peer), and a Node-usable `hightable/dataframe`
subpath means the data side can be tested without a browser.

Two properties matter beyond convenience:

- `getCell` returning `undefined` means "not resolved yet", which the grid
  renders as a loading cell. Our listing is complete today, but a paged or
  streamed listing needs no new vocabulary later.
- `orderBy` and `selection` can be **controlled by the parent**, which is the
  only mode compatible with a controller that already owns sort and filter.

### TanStack Table v9

Headless and excellent, but structurally wrong here. It **owns its state** via
TanStack Store (fine-grained reactivity on alien-signals) — a second reactive
system beside `BaseClass`, which file 07 rejected on purpose. It wants `data`
as an in-memory array and runs its own filter → group → sort → expand →
paginate row-model pipeline, duplicating what `PanelController._project()`
already does (C3), with the two free to disagree. And it does not virtualize:
that is TanStack Virtual, a separate library.

It would be the right choice if we needed column grouping, pinning, faceting or
aggregation. A two-panel commander needs none of those.

**Neither library is load-bearing.** The adapter is typed **structurally**, not
against HighTable's types, so `fm-ui` builds and tests without React and the
grid can be swapped for any windowed renderer that speaks the same shape.
Verified: our adapter object is accepted by HighTable's own `sortableDataFrame`
utility unmodified.

## The mismatch worth naming: selection

**HighTable's `Selection` is an array of row-index ranges** over the sorted
virtual table. Ours cannot be.

C4 refreshes listings from underneath the user whenever a job touches the
directory, and C2/C3 re-sort on demand. An index-keyed selection silently
shifts on every one of those: select `a.txt`, let a copy land `A-first.txt`
ahead of it, and the selection now points at a different file — with no error,
no flicker, nothing to notice before pressing Delete.

So `TableModel.selected` is a **set of paths**, and `selectionRanges()` derives
contiguous index ranges *at render time* for the grid's API. The truth stays
the path set; the ranges are a projection that is recomputed whenever the rows
change. M1 (key the selection by index) fails three tests, including one that
inserts a file ahead of the selected row and checks which name is still
selected.

The same rule covers `marks` (C4) and, less dramatically, the cursor — which is
an index, and is therefore **clamped** when the listing shrinks under it.

## A version discrepancy, recorded

The README documents `OrderBy` as a single `{ column, direction }` object. The
installed 0.26.4 takes an **array** of them (multi-sort), and its only
`direction` value is `"ascending"`.

That settles a design question rather than causing a problem: **sorting stays
with the controller.** The grid reports a header click, the controller writes
`input.sortColumn`, and `_project()` produces the ordering — including
descending, which the grid's vocabulary cannot express. Two orderings that can
disagree is exactly the failure this avoids, and `orderByFor()` returns an
empty array when we are sorting descending, so the grid never believes it is in
charge.

## What was built

`TableModel` (in `fm-app`) — pull-based projection: `rowCount`,
`getCell(row, column)`, `getRowKey(row)`, `isSelected`, `markOf`,
`selectionRanges()`, column descriptors with i18n label keys, sort column and
direction, cursor. The controller writes it; the view only reads it.

`toDataFrame(model)` (in `fm-ui`) — a projection holding **no state**: live
getters for `numRows` and `columnDescriptors`, one `update` event per model
pulse, and a `dispose()` that unsubscribes.

## Acceptance criteria, as tested

Pull not push: row count and per-cell access rather than an array;
`undefined` past the end reads as "not loaded".

**An empty string is a value, not an absence** — a directory's blank size cell
must not be conflated with an unresolved one, or the grid renders a permanent
loading shimmer on every folder. M3 makes this concrete.

Selection: survives a refresh that reorders the listing; drops a row that no
longer exists without renumbering the rest; derives correct contiguous ranges
across a gap.

Cursor: clamped when the listing shrinks, unmoved when it grows.

Adapter: columns and `numRows` read **live** (M4: snapshotting `numRows` fails);
one pulse → one `update`; `dispose()` unsubscribes; a present value is wrapped
and an absent one stays `undefined` (M5).

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | selection keyed by row index | 3 |
| M2 | cursor not clamped when the listing shrinks | 1 |
| M3 | empty size conflated with unavailable | 1 |
| M4 | adapter snapshots `numRows` | 1 |
| M5 | adapter wraps `undefined` as a value | 1 |
| M6 | `dispose()` does not unsubscribe | 1 |
| M7 | selection ranges merged across a gap | 1 |

## Next — D2b

The React panel itself: `HighTable` fed by `toDataFrame`, keyboard cursor and
selection writing into `input`, job progress reflected from models, the
floating window for a slot-less panel, internal drags on a private MIME type.

That rung needs a **browser runner** (Vitest + Playwright), which is also where
the C0.5 gaps close: OPFS and File System Access, permission prompts, and
revoked handles. It is the only remaining rung whose failure mode is "it works
but feels bad", so the 100k-row scroll and filter budgets are measured there
rather than asserted here.

