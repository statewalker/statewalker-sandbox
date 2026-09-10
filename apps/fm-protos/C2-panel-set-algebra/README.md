# C2-panel-set-algebra — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/C2-panel-set-algebra/`._

---

<!-- source: 01-C2 rung record and code.md -->

# C2 — Panel set algebra · rung record

_9 September 2026 · green: 124/124 (28 new) · mutations killed: 8/8 (one after re-aiming)_

## Verdict

Two orders over one id set behave exactly as file 03 describes, under 1000
random operations across five seeds. Promotion grade: **Adopt**. First model
written with the C1 kit from the first line.

## Design points the tests pin down

**One list cannot do both jobs.** `order` is a stable ring that activation never
touches; `mru` is an activation stack. The mutation that merges them (M1) fails
six tests — if activation reordered what Tab walks, every Tab press would put
the last-used pair back at the front and panels C…N become unreachable.

**Naming is append-only.** Numbering is assigned once at creation and survivors
are **never** renumbered when a duplicate closes. Renaming a panel the user is
looking at, in order to tidy up a sequence, is worse than a gap in it. Removing
`Docs` leaves `Docs (2)` as `Docs (2)`.

**A full layout does not throw.** A panel added with no free slot gets
`slot: undefined` and still joins both orders — floating, with the view layer
deciding how to show it. This keeps "unknown or absent slot" a view-layer
decision, never an error escalated to a controller.

**Slots are freed by removal**, so closing the left panel and opening a new one
puts it back in `left` rather than pushing it to the next free slot.

**New panels are inserted after the active one**, not appended — a new panel
appears next to the one the user was working in.

## Acceptance criteria, as tested

Ring and MRU: identical id sets at all times; activation churn never reorders
the ring; every panel reachable by Tab in N−1 steps; wrapping in both
directions; `mru[0] === activeId` after every activation.

Target: implicit with two panels (`needsPicker: false`); `mru[1]` with three or
more, with `pickerOrder()` in MRU order; **undefined** with one panel.

Removal, at the **head, middle and tail** of the ring (the §2.6 symmetry rule
from file 16): both orders stay consistent; `mru[1]` is promoted when the
active panel goes; the last removal leaves no active panel, does not throw,
returns `undefined` from `next()`, and reports `canOperate() === false`.

Slots: first-free defaulting; explicit request honoured; graceful decline when
full; freed on removal.

Naming: last path segment; letter fallback at a root (A, then B); deterministic
disambiguation; no renumbering of survivors.

Model discipline (C1 kit): `order` and `mru` are **replaced**, never mutated.

Property tests: five seeds × 200 random add/activate/remove operations, each
step asserting set equality between the two orders, no duplicate ids,
`mru[0] === activeId`, full ring reachability, and **no slot held twice**.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | one list for both orders (ring reordered on activate) | 6 |
| M2 | target may be the source panel itself | 3 |
| M3 | picker always shown, even with two panels | 1 |
| M4 | removal does not promote `mru[1]` | 7 |
| M5 | slot never freed on removal | 2 |
| M6 | new panel appended instead of inserted after active | 1 |
| M7 | removal renumbers survivors to close the gap | 1 (after re-aiming) |
| M8 | `next()` moves the ring without updating MRU | 5 |

M7's first attempt was weak — it only affected the very first panel, which never
collides. Re-aimed as "recompute every name on removal", which is the behaviour
the rule actually forbids, it dies. A surviving mutation is a claim about the
*mutation* as often as about the tests.

## A note on the kit catching a test bug

`expectReplacedNotMutated(panels, () => panels.mru, () => panels.activate(ids[2]))`
failed — because `ids[2]` was already active after `add()`, and `activate()` is
idempotent by design. The kit was right and the test was wrong. Worth recording
because it is the first time a C1 helper adjudicated a disagreement, and it
adjudicated correctly.

## Code

`packages/fm-app/src/panels-model.ts` and
`packages/fm-app/test/c2-panel-set.test.ts` are in the archive beside this file.
The heart of it:

```ts
/**
 * C2 — two orders over ONE id set.
 *
 * `order` is a stable ring: Tab walks it and activation never reorders it. If
 * activation reordered what Tab walks, panels C…N become unreachable, because
 * every Tab press would put the last-used pair back at the front.
 *
 * `mru` is an activation stack with the active panel at its head. It answers a
 * different question — "which panel did the user mean?" — and that is what the
 * operation target reads.
 *
 * One list cannot do both.
 */
```

```ts
  /**
   * The most recently used OTHER panel. With two panels this degrades to "the
   * other one" and no picker appears; with three or more, the picker is shown
   * with this preselected, so Enter is always the sensible answer.
   */
  targetFor(sourceId: string): TargetChoice | undefined {
    const candidates = this.mru.filter((id) => id !== sourceId);
    if (candidates.length === 0) return undefined;
    return { id: candidates[0], needsPicker: this.order.length > 2 };
  }
```

```ts
  remove(id: string): void {
    if (!this._panels.has(id)) return;
    this._panels.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.mru = this.mru.filter((x) => x !== id);
    // The active panel's successor is mru[1] — the panel the user was in
    // before this one — which is now mru[0] after the filter.
    if (this.activeId === id) this.activeId = this.mru[0];
    this.notify();
  }
```

## Next

**C3 — listing lifecycle**: the failure matrix (partial buffer always
discarded; failed refresh keeps entries `stale`; failed navigation clears
them), and empty-vs-missing disambiguated by `stats()`, now using the real
`Stats` union from P1 so size and date columns follow storage capability.

