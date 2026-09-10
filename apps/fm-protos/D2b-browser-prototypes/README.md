# D2b-browser-prototypes — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/D2b-browser-prototypes/`._

---

<!-- source: 01-D2b rung record and toolchain.md -->

# D2b — Browser prototypes: OPFS and the grid at scale · rung record

_10 September 2026 · browser: 13 passed (2 files) · node: 221 passed, 1 skipped · Chromium 141_

## Toolchain

Playwright **packed from npm**, no CDN download. The container ships browser
build **1194** at `/opt/pw-browsers`, and Playwright pins a browser revision per
release — 1.63 wants 1243 and refuses to launch. The matching release is
**1.56.1** (chromium 1194), found by reading `browsers.json` from successive
`playwright-core` tarballs.

```
npm i -D playwright@1.56.1 playwright-core@1.56.1 @vitest/browser-playwright react react-dom
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers vitest run --config vitest.browser.config.ts
```

`--no-sandbox` is required as root. Scripts: `npm test` (Node, 221),
`npm run test:browser` (Chromium, 13), `npm run test:all`.

Browser tests live in `packages/*/browser/`, kept out of the Node `include`
glob. Everything up to this rung was Node-testable by design and stays that
way; this config exists only for what a browser is genuinely required to
prove.

## OPFS — the C0.5 gap, closed

Seven tests against the real origin-private filesystem, each a browser
counterpart of an assertion previously made only against mem or Node:

- P1 conformance: the file variant with real size and mtime; a directory
  narrowing to exactly `{ kind: "directory" }`; **a zero-byte file as
  `size: 0`**, not mistaken for a directory.
- Deterministic enumeration: two runs over the same tree, identical order —
  the precondition the P4 cursor comparison rests on.
- Cancellation on a clean batch boundary (`completed % 4 === 0`).
- **Resume from a checkpoint stored in OPFS itself**, with the checkpoint
  `FilesApi` being the same origin-private filesystem: 12 files, nothing
  written twice.
- Partial target removed when a write is interrupted mid-stream.

All pass unchanged. Mem and Node were not lying about OPFS either.

## The integration finding: the grid does not bound its own height

The 100k-row case failed with the library's own guard —
`attempted to render too many rows 100000` — and rendered **zero** rows, while
100- and 1000-row cases "passed" by rendering every row.

That second half is the real lesson: **the small cases were passing without
virtualization at all.** The grid's root grew to its full content height
(3336px inside a 600px host), so the scroll container never constrained, no
window was computed, and every row went to the DOM. At 100k the guard caught
what the small cases had quietly hidden.

Two facts make this a contract rather than a bug:

1. The grid does not impose a height on itself — the **host** must.
2. Its class names are **hashed CSS modules** (`_hightable_yr0cj_1`), so a host
   cannot target its internals to fix this afterwards.

So the host sizes the wrapper:

```css
.fm-grid-host { height: 600px; width: 800px; overflow: hidden; }
.fm-grid-host > * { height: 100% !important; max-height: 100% !important; }
```

This belongs in the panel's own styles, and the assertion
`firstElementChild.clientHeight <= 600` now guards it — otherwise a future
layout change silently returns us to rendering 100k rows into the DOM.

## Measured, not asserted

| Property | Budget | Result |
| --- | --- | --- |
| Rows in the DOM at 100k entries | < 200 | a few dozen |
| `setRows(100k)` | < 50 ms | ~10 ms |
| 1000 `getCell` at row 99 000 vs row 0 | < 4× | comparable |
| Filter projection over 1000 rows | < 20 ms, no I/O | well inside |

The far-end cell read matters: pull-based access must be **O(1) in the row
index**, or scrolling to the bottom of a large directory degrades. The test
compares near and far rather than fixing an absolute number, so it stays
meaningful on slower hardware.

## Model-driven, proven at the DOM

- **One model pulse re-renders the grid with no prop change**: the controller
  replaces the listing, the view is told nothing, and `renamed-*` appears.
- **The window moves on scroll** and different cells arrive.
- **A filter shrinks the row count live** and costs no I/O.

The scroller is found by structure (`scrollHeight > clientHeight`) rather than
by class name — hashed CSS modules again, and a test that hard-codes a hashed
name breaks on the next release of the library.

## Still open for D2c

Keyboard cursor and selection writing into `input`; job progress reflected in
a real panel; the floating window for a slot-less panel; internal drags on a
private MIME type; and the File System Access API paths — `showDirectoryPicker`
and revoked handles — which need a browser context with permissions granted,
not just OPFS.

---

<!-- source: 02-D2c grid sizing decision.md -->

# D2c — Bounding the grid's height: three strategies, measured

_10 September 2026 · browser: 20 passed (3 files) · node: 221 passed, 1 skipped_

## The question

D2b bounded the grid with an injected stylesheet rule using `!important`. The
proposal on the table: **define the container size explicitly and set
`height: 100%` on the grid's DOM node imperatively.**

Rather than argue it, all three candidates were rendered at 100 000 rows in
Chromium and measured.

## The answer, and it is neither of the first two

The library's own root rule is:

```css
._hightable_ { display: flex; flex: 1; min-height: 0; position: relative; flex-direction: column }
```

**It is already written to be a flex child.** Given a flex parent with a
definite height, it fills and clips by itself. The host needs three lines and
no override at all:

```css
.fm-grid-host {
  display: flex;
  flex-direction: column;
  min-height: 0; /* so the host can shrink inside its own flex parent */
}
```

Our D2b harness made it a plain block container, so `flex: 1` had nothing to
resolve against and the root grew to its content height (3336px inside a 600px
box). The `!important` rule fixed the symptom; the flex parent removes the
cause.

## Why the imperative variant cannot work here

`style.height = "100%"` after mount is not merely less tidy — at scale it never
gets the chance to run:

- **The grid computes its window during its FIRST render.** Unbounded at 100k
  rows it refuses outright (`attempted to render too many rows 100000`), React
  commits nothing, and `host.firstElementChild` is **null**. There is no node
  to style. A post-mount write cannot fix a pre-mount decision.
- **It works at small row counts** — 500 rows render, the write lands, the box
  looks right. That is what makes it dangerous: the technique passes every
  small test and fails on the first large directory, in front of a user.
- **It does not survive a remount.** After `root.unmount()` and a re-render —
  which is exactly what happens whenever `ui:show-panel` settles and is
  re-issued — `style.height` is back to `""` and the grid is unbounded again.
  Every mount would have to re-apply it, from code that also has to know when
  mounting finished.

By contrast, the flex host **survives a remount** and **follows a resize**
(600px → 300px) with no code running at all, because the constraint lives on a
node we own rather than on one the library replaces.

## Results

| Strategy | Windows at 100k | Survives remount | Follows resize | Code required |
| --- | --- | --- | --- | --- |
| A · stylesheet + `!important` | yes | yes | yes | a rule that fights the library |
| B · imperative `height:100%` | **no — nothing renders** | no | n/a | mount hook + re-apply logic |
| C · **flex host** | yes | yes | yes | three CSS lines |

Seven tests in `d2c-sizing.test.tsx` hold each row of that table, including the
two negative ones for B, which are written as assertions rather than left as
comments: `mounted === false` at 100k, and `style.height === ""` after a
remount.

## What shipped

`packages/fm-ui/src/grid-host.css` — the three lines, with the reasoning above
it. The D2b harness now uses a plain flex host, and the `!important` rule is
gone.

The general rule this generalises to, worth carrying into the rest of Phase D:
**a constraint a third-party component needs at first render belongs on a node
we own, expressed declaratively.** Anything applied afterwards is a race with
the component's own lifecycle, and anything applied with `!important` is a
guess about its internals — which, with hashed CSS-module class names, we
cannot even read reliably.

---

<!-- source: 03-D2d flex chain verification.md -->

# D2d — The flex chain: verified, with one trap

_10 September 2026 · browser: 25 passed (4 files) · node: 221 passed, 1 skipped_

## Yes, it works — and it does not need a fixed pixel height

D2c proved the flex host with an explicit `height: 600px`. That is not the
real case: a panel fills a slot inside a layout that fills the viewport, so if
the fix only worked with a hard-coded pixel value it would be the same problem
moved one level up.

Verified in Chromium at 100 000 rows, with **no pixel height anywhere below the
app shell**:

- **Height inherited through a flex chain** — `height:100vh` shell → panel row
  (`flex:1; min-height:0`) → panel slot (`flex:1`) → grid. Windows correctly:
  a few dozen rows in the DOM, grid height ≤ host height.
- **With a toolbar and status bar** above and below (`flex:none`), the grid
  takes the remainder and still windows. The host is shorter than the shell,
  and greater than zero.
- **Resizes with no code running**: shrinking the shell from 600px to 300px
  shrinks the host and the grid keeps rendering a bounded window.

So the answer to the question as posed: **yes — a flex container works, and
"fixed height" is only needed on the outermost element that establishes the
bound.** Everything below it inherits.

## The trap: `min-height: 0` is load-bearing

A flex item's `min-height` defaults to **`auto`**, which refuses to shrink
below its content. So one missing `min-height: 0` anywhere between the sized
ancestor and the grid restores the unbounded case exactly as if the host were a
block element.

Two tests hold this, and the pair matters more than either alone:

| Chain | 100k rows | 500 rows |
| --- | --- | --- |
| with `min-height: 0` throughout | windows, a few dozen rows in the DOM | fine |
| one `min-height: 0` omitted | **refuses to render — nothing mounts** | **looks fine** |

At 500 rows the broken chain mounts, renders all 500 rows, and the host grows
past the viewport — the page scrolls instead of the table. Nobody would notice
in review. The same defect at 100k trips the library's guard and renders
nothing.

This is the third time in Phase D that a browser behaviour has been **invisible
at small row counts and fatal at large ones** (D2b: the harness that never
windowed at all; D2c: the imperative write that works at 500 and cannot run at
100k). The 100k case is not a performance test — it is the only size at which
these bugs are visible.

## What shipped

`packages/fm-ui/src/grid-host.css`, now two classes and the reasoning:

```css
.fm-grid-host {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

/* Every flex ancestor between the sized element and the host needs this. */
.fm-flex-fill {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
```

`.fm-flex-fill` exists because the requirement is a property of the **chain**,
not of the host: naming it makes the intermediate elements' obligation explicit
instead of leaving it to be rediscovered.

## Suggested guard for the panel

When the React panel lands (D2e), one assertion is worth carrying in the
browser suite permanently: mount the real panel inside the real app shell at
100k entries and assert the DOM row count stays under a couple of hundred. It
costs one test and catches any future layout change that silently breaks the
chain.

---

<!-- source: 04-D2e how the grid virtualizes from the model.md -->

# D2e — How the table uses the model to virtualize

_10 September 2026 · browser: 32 passed (5 files) · instrumented, not asserted from theory_

## Measured at 100 000 rows

A recording proxy was placed between the grid and the adapter. One mount into a
600px host produced:

| | |
| --- | --- |
| Rows in the listing | 100 000 |
| `numRows` reads | **1** |
| `getCell` calls | **114** (38 rows × 3 columns) |
| Distinct rows asked about | **38**, range `[0, 37]` |
| Rows in the DOM | 38 |
| Scroll height synthesised | 3 300 034 px |

The model is asked about **thirty-eight rows out of a hundred thousand**, and
the scrollbar still represents all of them.

## The mechanism, in four moves

**1. `numRows` becomes geometry, not data.** The grid reads the count once and
multiplies by the row height to synthesise a 3.3-million-pixel scroll surface.
The listing's *size* is what makes the scrollbar right; the listing's *contents*
are never needed for it.

**2. `getCell(row, column)` is called only for the window.** The requested rows
form a **contiguous range**, not a scatter, and the range is slightly larger
than what is painted — overscan, so a scroll of one row does not immediately
hit unresolved cells. `getRowNumber(row)` provides the row header the same way.

**3. Scrolling moves the range.** After scrolling to 20 000px the newly
requested rows are all beyond the previous maximum: the grid did not re-read the
listing, it asked about a different window. Fewer than 300 rows are pulled for
the move.

**4. `eventTarget` closes the loop.** `TableModel.notify()` → one `update`
event → the grid re-pulls **the current window only**. A listing replaced under
the grid costs a window's worth of reads, not 100 000 — which is precisely what
makes C4's operation-sourced invalidation affordable: a copy job finishing in a
visible directory re-lists the panel and the grid re-reads 38 rows.

## Why the model is shaped this way

`TableModel` deliberately exposes `rowCount` and `getCell(row, column)` and
**no array of rows**. A test asserts the absence:

> If a `rows` accessor existed, a future renderer would reach for it and the
> window would quietly become a copy.

Everything the grid needs is an O(1) question about an index. That is also why
D2a's benchmark compares cell reads at row 99 000 against row 0 — pull-based
access has to be constant in the index, or scrolling to the bottom of a large
directory degrades even though the DOM stays small.

## The absence that pays off later

`getCell` returning `undefined` means **"not resolved yet"**, and the grid
renders that as a busy cell rather than an empty one. Today every row is
resolved, so no busy cells appear — asserted, so the distinction stays honest.

But the vocabulary is already in place: a paged listing, a streamed `list()`,
or a remote adapter that fetches metadata lazily can return `undefined` for
rows it has not reached and fill them in with a `notify()`. No new protocol,
no change to the view. That is the payoff for the empty-string-versus-undefined
rule from D2a: `""` is a directory's blank size, `undefined` is an absence, and
conflating them would either show shimmer on every folder or hide genuine
loading.

## The layering, end to end

```
FilesApi.list()            →  PanelController._load()      (C3: one buffer, discarded on failure)
PanelModel.entries         →  _project()                   (C3: filter + sort, no I/O)
PanelModel.visible         →  TableModel.setRows()         (D2a: the projection the user sees)
TableModel                 →  toDataFrame()                (D2a: rowCount + getCell + eventTarget)
DataFrame                  →  HighTable                    (D2b–D2d: window, overscan, scroll surface)
```

Every arrow is one-way. The grid never writes to the model; user gestures go
back through `input`, and the controller decides — the same discipline as every
other view in the system.

## Tests

`packages/fm-ui/browser/d2e-pull-window.test.tsx`, seven cases: window size,
contiguity and overscan, the range moving on scroll, one pulse re-pulling only
the window, the total being re-read when a filter shrinks the projection, the
absence of a rows array, and unresolved-versus-empty cells.

---

<!-- source: 05-D2f panel component.md -->

# D2f — The panel component · rung record

_10 September 2026 · browser: 41 passed (6 files) · node: 221 passed, 1 skipped_

## What shipped

`PanelView` — the first real component in `fm-ui`. It knows **two models and
nothing else**: no bus, no controller, no `FilesApi`. Plus `useModel`, the
entire React binding, in fifteen lines over `useSyncExternalStore`:

```ts
export function useModel<M extends BaseClass, T>(model: M, selector: (model: M) => T): T {
  const subscribe = useCallback((onChange: () => void) => model.onUpdate(onChange), [model]);
  const snapshot = useCallback(() => selector(model), [model, selector]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
```

This is the selector semantics that would otherwise justify a store library
(file 07) — and it is also why C1's replace-don't-mutate rule is load-bearing:
`useSyncExternalStore` compares snapshots by strict equality, so an in-place
`push` would leave the panel frozen on screen.

## Every gesture goes through `input`

| Key | What the view does | What decides |
| --- | --- | --- |
| ↓ / ↑ | writes `table.cursor`, clamped | the view (pure view state) |
| Space | toggles `table.selected` **by path** | the view |
| Enter | writes `input.requestedPath` + `navigateCount++` | the **controller** |
| Backspace | `input.backCount++` | the **controller** |

Enter on a directory states an intent and stops. The controller navigates, and
may decline — the test asserts `panel.path` changed *and* that the DOM followed
the model rather than the event. Enter on a file does nothing.

Selection is keyed by path, and the test proves why: select a file, then land a
new file that sorts ahead of it, refresh, and the same path is still selected.
An index-keyed selection would silently point at a different file.

## The mistake this rung nearly shipped

The 100k guard test asserted `rendered < 200` — and **passed while rendering
zero rows**, because `PanelView` never imported `grid-host.css`, so
`.fm-grid-host` was a plain block element, the flex chain was broken, and the
grid refused to render at all.

Exactly the failure D2b and D2d had already documented, reproduced one rung
later by the person who documented it. Two fixes:

1. **The component ships the constraint it depends on**: `panel-view.tsx`
   imports `./grid-host.css`, and the stylesheet now covers `.fm-panel`,
   `.fm-panel-breadcrumb`, `.fm-panel-error` and `.fm-grid-host` as one chain.
   Leaving the host to remember is how it breaks.
2. **Every windowing assertion bounds the row count from BOTH sides.**
   `> 0 && < 200`. A one-sided bound cannot tell "virtualized correctly" from
   "refused to render", which are the two outcomes it exists to distinguish.

## Unhandled errors, handled honestly

Two suites deliberately provoke the grid's guard — D2c strategy B at 100k, and
D2d's chain with a missing `min-height: 0`. React reports the refusal as an
unhandled error, which masks the run. The browser config now suppresses it **by
message only**, with the reasoning inline:

```ts
onUnhandledError: (error) => !/attempted to render too many rows/.test(String(error?.message)),
```

Safe because an accidental occurrence still fails a test now that both bounds
are asserted — the suppression hides the noise, not the signal.

## Also asserted

- Breadcrumb, row count and cursor render from the models (`data-*`
  attributes), and follow a model pulse with no prop change.
- The cursor does not run off either end.
- `stale` and `error` surface from the panel model, `error` as `role="alert"`.
- Teardown order: unmount, let it settle, then detach. A grid observing a
  **detached** node measures zero height, concludes every row is visible, and
  throws — teardown is part of the integration contract, not an afterthought.

## Next

`fm-ui` still lacks the floating window for a slot-less panel (C2 leaves
`slot: undefined` for the view layer to decide), internal drags on a private
MIME type, and the File System Access paths — `showDirectoryPicker` and revoked
handles — which need granted permissions rather than OPFS. Then D3: config,
session, and the outside world.

---

<!-- source: 06-D2g drags and floating panel.md -->

# D2g — Internal drags and the floating panel · rung record

_10 September 2026 · browser: 51 passed (7 files) · node: 221 passed, 1 skipped · mutations killed: 6/6_

## Internal drags: one private MIME type

```ts
export const FM_SELECTION = "application/x-fm-selection";
```

A drag carrying `text/uri-list` or `Files` is something the browser **and** the
desktop will both try to interpret — a panel-to-panel move handed to the
operating system as a download. Ours carries one type nothing else claims.

The test asserts both halves: `FM_SELECTION` is present, and `text/uri-list`
and `Files` are **absent**. M1 (also write `text/uri-list`) dies on it.

`dragover` is `preventDefault()`-ed, which is what stops the browser navigating
to the payload — asserted through `event.defaultPrevented` rather than assumed.

## The view delivers a request, never an operation

A drop produces a resolved `{ files, target, sourcePanelId, external }` handed
to the host through `onDropFiles`. The panel performs nothing: the request
carries **resolved locations**, exactly the shape `files:copy` takes (C5), so
the host or an agent can act on it with no translation.

- Selection drives the payload; with nothing selected it falls back to the
  cursor row — the behaviour every commander has.
- A drop onto the panel that started it is a no-op.
- An OS drop (a `File` in the `DataTransfer`, no internal payload) is reported
  as `external: true` with no `sourcePanelId`, which is the D3 ingest path:
  dropped handles become a read-only ephemeral storage and the copy is an
  ordinary job.

## The panel the layout cannot place

C2 hands the view layer a panel with `slot: undefined` when the layout is full,
and says the decision belongs here. It does:

```ts
export function placements(panels: PanelsModel, slots: Record<string, HTMLElement>): Placement[]
```

- A panel whose slot the layout **does not declare** also floats — the model
  may name `aux-1` in a layout that offers only `left`. Still a view-layer
  decision, never an error handed back to a controller (M6).
- **One floats at a time** (M5). A second unplaceable panel means the layout is
  wrong, not that we need a window manager.
- The floating panel is an ordinary non-modal region: `position: absolute`, no
  focus trap, and — because it is a `PanelView` like any other — still a drag
  source and a drop target.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | selection also written as `text/uri-list` | 1 |
| M2 | external drop treated as internal | 1 |
| M3 | self-drop not ignored | 1 |
| M4 | `dragover` not claimed | 1 |
| M5 | every unplaceable panel floats | 1 |
| M6 | unknown slot treated as placed | 1 |

## Still open in Phase D

**File System Access.** `showDirectoryPicker` requires a user gesture and opens
a native chooser that Playwright cannot drive, so the folder-download path and
revoked-handle behaviour stay unverified. Options for D3, in preference order:
a manual checklist run once against a real browser; a fake `showDirectoryPicker`
injected into the page that returns an OPFS-backed handle, which tests our code
but not the API; or leaving it as a documented gap. It should not be quietly
asserted against a stub and called covered — the C0.5 root-permission finding is
the cautionary case.

Then **D3**: `storages.json` and `session.json`, the missing-storage error
panel, and the ephemeral storages that the `external: true` drop above already
has a shape for.

