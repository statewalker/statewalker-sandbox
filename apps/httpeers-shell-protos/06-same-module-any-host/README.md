# 06 — Same module, any host

`pnpm test 06-same-module-any-host`

**Question.** Does the same application module mount unchanged, standalone and
hosted?

**Answer: yes — the two paths do not diverge.** Prototype 1 asserted this design
(an application is a default module receiving a context, usable in either host)
but could not test it: it was headless, and `View.mount(root, ctx)` typed `root`
as `unknown`. This rung closes that, against `lib/mount.js` — the consolidated
`shell-core` — with the docked half running on real Dockview through
`lib/dock.js`.

**Reject condition** (note 23): the two paths diverge, or the module has to know
which host it is in.

## The rule that makes it true rather than aspirational

`AppHost` exposes no surface id, no pane id, and no reference to the dock or the
renderer, so **a module cannot discover its host and therefore cannot branch on
it**. The surface id is an implementation detail the host chooses — the module's
own id when standalone, the pane id when docked — and it is never visible from
inside. The second half is that there is **one host builder**: `createAppHost`.
Identical shape holds by construction, not by two code paths that happen to
agree today.

## Making the two paths genuinely different

An identical-outcome assertion over two identical mounts proves nothing, so the
first test is a non-vacuity guard. In these tests the docked path differs from
the standalone path in four ways at once: the DOM root is created and owned by
Dockview, the renderer is built by `dock.ts`'s `createComponent` rather than by
`mountStandalone`, the surface id is `pane-alpha` rather than `confirm-dialog`,
and a sibling pane exists.

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | The two mounts really are two | Different `data-surface` id, different `Renderer` instance, disjoint DOM roots, and the docked surface nested inside Dockview-built DOM | Both paths collapse to one mount, making every claim below vacuous |
| 2 | The host is the **same shape** in both | `Object.keys(host).sort()` equals `["getData","notify","render","setData"]` for both | A member is added to one path — note 33's mutation 1, "leak `surfaceId` into the docked host only" |
| 3 | The host exposes **nothing a module could branch on** | `surfaceId`, `paneId`, `id`, `dock`, `dockview`, `renderer`, `container`, `element`, `host`, `standalone`, `docked` are all absent under `in`; every value is a function, so no data field can smuggle an id | Any of those becomes reachable |
| 4 | `activate` receives **one argument** | Argument count recorded inside the module, asserted `[1, 1]` | A second parameter appears — the obvious place to put "which host am I" |
| 5 | There is **one builder**, so the shapes cannot drift | A host built directly by `createAppHost` over a throwaway renderer is key-identical to the one `mountStandalone` produced | `mountStandalone` builds its own host inline — note 33's mutation 2, the drift that happens naturally over time |
| 6 | The same module renders **byte-identical markup** in both | `innerHTML` of the `[data-surface]` element compared across paths, with a length/content guard so it cannot pass by both being empty | Anything host-derived leaks into the component tree |
| 7 | The surface id never reaches the module's markup | Neither `pane-alpha` nor `confirm-dialog` appears in its own surface body | The host writes its chosen id into the tree the module authored |
| 8 | `setData` / `getData` round-trip identically | Same initial model in both; `setData("/form/name","Ada")` then `getData()`, and the bound `input.value` reflects it | The two paths hold data differently, or the binding stops updating |
| 9 | `notify` reaches whatever embeds the module, in both | `onNotify` collected per path | Notification works in one host only |
| 10 | The action **affordance** is identical in both | `data-action="confirm"` on the button in both trees; the standalone event carries `name`, `context`, and the host-chosen `surfaceId` | The declared action renders differently depending on host |
| 11 | **DEFECT**: a docked module's actions never fire | Standalone click yields one `ActionEvent`; docked click yields none; a hand-wired renderer proves the same module and the same `createAppHost` produce an equal event once the callback is on the renderer | The wiring is fixed — this test is written to go **red** then. See below. |
| 12 | Two panes running the **same module** keep separate data models | Two panes, one module definition; typing into pane A's input leaves pane B's model at its initial value | One renderer is shared across panes, or the data model is keyed by module id |
| 13 | Standalone `dispose()` runs the disposer and deletes the surface | `trace.disposals`, `renderer.surfaces()`, and the `[data-surface]` element | Either half is skipped |
| 14 | **Known gap**: closing a dock pane does *not* run the disposer | `dockview.removePanel` removes the pane; `trace.disposals` stays empty | Dockview's disposal events get wired — again, deliberately red then |

14 tests, all passing. Typecheck clean.

## What this rung found

**`createAppHost` accepts `onAction` and silently ignores it.**
`AppHostOptions` declares `onAction?`, and `createAppHost` takes an
`AppHostOptions` — but it only ever reads `onNotify`. Actions are wired at
*renderer construction*, `createRenderer(root, catalog, { onAction })`, which
`mountStandalone` does and nothing else can: `lib/dock.ts` builds each pane's
renderer itself, with no options and no hook to supply any.

So a module mounted into a pane renders correctly, holds data correctly, and its
buttons are dead. Test 11 pins it and isolates the cause: the identical module
through the identical `createAppHost` produces an event equal in every observable
field as soon as the renderer is the one carrying the callback.

**This is a wiring gap, not a hole in the abstraction** — the "same module, any
host" claim survives it — but it is the same trap as the documented "`theme` is
accepted and ignored" hole, and undocumented. `lib/` is read-only for this rung,
so it is reported, not fixed. Either `onAction` belongs on `createRenderer` alone
and should leave `AppHostOptions`, or `createShellDock` needs to accept renderer
options and forward them in `createComponent`.

## One divergence from the note

Note 33 describes the docked path as `dock.mountApp`, calling the shared
`createAppHost`. Consolidated `lib/dock.ts` (rungs 7 and 7a) has **no
`mountApp`**: a pane owns its renderer, and the `AppHost` is composed on top by
whoever mounts the module. The property under test is unaffected —
`createAppHost` is still the one and only host builder — but the docked path is
assembled in the test rather than imported, and that is stated in the test file
too, because the whole point of this rung is that the two paths are not quietly
two. The missing `mountApp` is also *why* the `onAction` gap exists.

## Not covered here

- **No browser.** happy-dom, with Dockview's container measurement stubbed by an
  explicit `dockview.layout(1200, 800)` — happy-dom reports every element as 0×0.
  Nothing visual is verified.
- **No module loading.** Modules are passed in as objects. Prototype 5's
  activation host does the lazy-import half; the two are still not joined.
- **No contribution registration.** A module can render and hold data but cannot
  contribute menu items or commands. Prototype 1's `commands` / `slots` /
  `enablement` context and this rung's `AppHost` remain separate vocabularies,
  and how they compose is undesigned — note 33 calls this the most significant
  remaining gap in the shell.
- **No isolation boundary.** Same DOM, no iframe, as decided in note 02.
- Module ids and pane ids are independent, and nothing prevents two panes from
  mounting modules with colliding internal component ids. Surfaces are separate,
  so it is currently harmless and unexamined.
