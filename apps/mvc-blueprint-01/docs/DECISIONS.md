# Decisions

What was decided, what was rejected, and why. Several of these reverse an earlier version of the
design — each reversal is recorded, because the reason something was *not* done is usually what the
next person needs.

Status: **adopted**, **rejected**, or **deferred**.

---

### D1 — Commands are the only channel between layers · adopted

Every operation is a command; every visible surface is a command. There are no callbacks passed
between layers and no "mount this view" API. Commands carry typed payloads and results, are
overridable by priority, and project directly as agent tools — the same surface a user drives, an
agent can drive.

### D2 — Views are command handlers · adopted

A controller shows something by emitting `ui:show-*(model)`. The view layer claims the command,
renders, and unmounts when it settles — from either side. Panels, dialogs, toasts and menus are one
mechanism at different lifetimes. See ARCHITECTURE §7.

### D3 — The view adapter is keyed on the declaration · adopted, reverses an earlier design

`adapter.on(decl, renderer)`. The previous adapter had a fixed struct of seven named renderer slots,
two of which (`job`, `conflict`) were Files Manager domain nouns — so it could not be reused. Keying
on the declaration keeps a typed model and result per view and names no domain noun.

A view is identified **by its command key and nothing else**. The old design kept a `kind` string
beside the declaration: two names for one thing, which can disagree.

### D4 — Three directories, not three packages · adopted, reverses an earlier design

The layers are `lib/todo-{core,app,ui}` behind aliases. The earlier plan chose three packages
"because that is the split a boundary suite can police". It was wrong on both counts: the sibling
app is one package and its suite polices it fine, and what let a boundary rot there was never having
a grep for it. Packages would have bought build steps and stale-`dist` hazards for nothing.

### D5 — Models are changed only through mutators · adopted

No caller assigns a field or writes a signal outside the model's own mutators. One intention, one
write, owned by the model. The parent checked this with B0 greps — a `.notify(` outside a model
module, an assignment through a receiver named `…model…` or `.input.`, a view naming a
controller-side method, and not through an alias. See ARCHITECTURE §3 and §5, and D20.

Here it is a fact of scope, not a grep: the signals live in the factory's closure, so nothing outside
it can hold a writable one, and the view is handed only the `view` facet (S4) — `replaceTodos` is not
a name it can reach. What B0 still checks is what remains checkable: *in todo-app, signals are
created only in a model; effects only in the controller and the kit*, and *todo-ui never names the
control facet*.

### D6 — Input fields come in three classes · adopted

Level, state-latest edge, event edge. The class decides the controller's obligation — reconcile,
coalesce, or honour every one — and an event edge must carry its payload, so it is a replaced queue,
not a counter. This distinction did not exist in the design this blueprint came from; every edge
there was state-latest, so the difference never showed. See ARCHITECTURE §5.

### D7 — Models expose named change channels · **superseded** (S4 / S1)

`onChangeNotifier` per meaningful change. A subscriber is woken only by the change it asked for.
Bare `onUpdate` is allowed only in a model module (`todo-app/src/*-model.ts`) and in
`todo-ui/src/use-model.ts`. See ARCHITECTURE §4.

Superseded by dependency tracking: the controller's effect reads a declared `edges` set
(ARCHITECTURE §4).

### D8 — An update latch · **rejected**

Proposed: a `newUpdateLatch()` so a controller could write a model it also observes without waking
itself — `update(() => model.setX(...))` suppressing notifications raised inside.

Rejected, and deliberately not exported from a shared package, because it is correct in the
synchronous case and silently wrong in three others:

1. **It cannot cover an async write, and cannot be fixed to.** `notify()` is synchronous, so the
   suppression window closes when the callback *returns*, not when its promise settles — and every
   `TodoApi` method is async. `update(async () => { await api.add(t); model.append(t) })` suppresses
   nothing while looking as though it does. Holding the flag across the promise makes the window a
   network round-trip; `AsyncLocalStorage` does not exist in a browser.
2. **Combined with change channels it loses changes permanently.** `onChangeNotifier` advances its
   remembered value *before* calling its callback. A latch that drops the callback leaves the channel
   believing the change was seen — and no later notify will ever re-fire it.
3. **A throw leaves it deaf forever**, since `notify()` has no error isolation.

Underneath all three: the latch's only power the alternatives lack is stopping a reaction that
**doesn't converge** — and a reaction that doesn't converge is already a bug. Its unique value is
masking a broken rule while hiding it from the tests that would catch it.

**Instead**, in order: check the controller really needs to write what it observes (usually it
should write an *outcome* instead); subscribe to a declared `edges` set — an effect that reads only
its own input, never what it writes — so it is not woken by its own writes;
**compare before writing in the mutator**, which raises no notify at all for an unchanged value and
survives `await`; use a watermark for edges; and for a genuinely shared model (peer sync), carry the
writer's identity in the data and skip your own.

Still rejected. `untracked` is not the latch: it decides what you depend on, not whether your writes
notify. A deferred write — `statewalker-models`' `autorun` returning an action run on a microtask —
is the latch in another form; probed, it turns a non-converging reaction into a silent microtask
loop.

### D9 — Registrations are owned by `newRegistry` · adopted

LIFO unwind, idempotent disposers, errors that do not stop the unwind, async. Teardown is the mirror
of setup with nobody sequencing it — the saga shape the dock shell will need when a mini-app fails
halfway through loading. See ARCHITECTURE §9.

### D10 — Controllers reach data through an async `TodoApi` · adopted, reverses an earlier design

The seam was first a `TodoStore { load, save }`, and before that the plan borrowed the Files
Manager's `FilesApi`. Borrowing consumer two's seam would have distorted the blueprint to fit it; a
synchronous store would have let a controller read and write in one tick, making the layering a
description of the file tree rather than of behaviour. `TodoApi` is the app's own port, every method
async, knowing nothing of commands, models or views.

### D11 — The bootstrap order is enforced by a token · adopted, and corrected twice

`bootstrap` mints a `ViewsReady` token after the view layer registers; a controller's `activate()`
refuses to run without one.

- The first version enforced the order only inside `bootstrap()`'s body, while the controller class
  stayed exported — anyone could construct and activate one with no views. The test suite itself was
  doing exactly that.
- The second version claimed a private constructor made the token unforgeable. It does not:
  `Object.create(ViewsReady.prototype)` passes `instanceof`, and a public static `_mint()` is callable
  by anyone holding the class.
- What holds is **module confinement**: the barrel exports the token as a type only, and B0 fails the
  run if `_mint` appears outside `views-ready.ts` and `bootstrap.ts`, or if any file but
  `bootstrap.ts`, `list-controller.ts` and the barrel imports `views-ready`. It stops mistakes, not
  deliberate evasion — no in-realm mechanism can. It is also shaped around one controller (see
  Deferred).

### D12 — `bootstrap` returns a capability, not a controller set · adopted

`createList(model)` returns `{ controller, release }`. Constructing every controller inside
`bootstrap` cannot serve either later consumer: the Files Manager opens and closes panels at run time,
the dock shell loads mini-apps after bootstrap returned. `release()` frees one controller without
tearing the app down — without it, a shell opening and closing panels would accumulate a closure per
panel until app teardown. `createList` after `dispose()` throws; it used to activate a controller on
a dead app without a word.

### D13 — `dispose()` is write-quiescent, not call-quiescent · adopted, after a deadlock

First version: dispose did not wait at all, and a disposed controller wrote the model 60 ms later.
Second version: dispose waited for in-flight work — and **deadlocked**, because the registry unwinds
controllers before views, so a run awaiting a view-settled command (an approval dialog) waited for a
dialog nobody could close. Final: dispose does not wait, and every await is followed by a
`_disposed` check. No write after dispose resolves; an api call already in flight may still finish,
and its result is dropped.

### D14 — Nothing escapes a `void` · adopted

Controller work is fired with `void`, so every failure is caught where it happens and reported
through `reportOutcome`. A watermark moves once the intent is consumed — for work with no question in
it, when the work landed (D15 covers the question). The first version had no error
policy at all: a rejected add was an unhandled rejection and a dropped item, and a failed reload left
the model permanently stale while its watermark claimed the work was done.

Extended: no effect throws (S2).

### D15 — A question answered is an intent consumed · adopted

A clear-completed that fails *after* the user confirmed is reported and **not** retried. The first
rule ("a watermark moves only when the work landed") was built for invisible, idempotent work;
applied to a modal question it re-prompts a user who already said yes, triggered by whatever
unrelated action woke the controller next. And with nothing to clear, no question is asked at all —
decided in the controller, because a host or agent can raise the intent too.

### D16 — A model's `onUpdate` covers its derived getters · **superseded** (S4 / S1), found in review

`visible()` reads the input sub-model's filter fields, which the outer model's `onUpdate` did not
cover — so a view bound to `visible()` would not re-render on a filter change. The first view worked
around it by subscribing to the filter fields itself; the fix went into the model, which now forwards
query changes. See ARCHITECTURE §3.

Superseded: `visible` is a `computed`.

### D17 — The headless adapter is a separate entry · adopted, found in review

`@todo/ui/adapter` exposes the view adapter without React. The node suites that test the view
protocol used to import `@todo/ui`, which also exported the React views — so they loaded React DOM
and the whole kit by accident, and would have broken the day any view touched `document` at import.

### D18 — Import the kit's own styles · adopted

`@import "@statewalker/ui.view.shadcn/styles"`, never a hand-written `@source` into the kit. The
neighbouring prototype hand-wrote a glob to a path that does not exist; a dead glob emits nothing and
reports nothing. A build-level test asserts a kit-only class reaches the CSS.

### D19 — Headless is enforced at resolution, not only by grep · adopted, found in review

B0 checked that a node suite *names* the view layer only as `@todo/ui/adapter`. A node suite that
imported `src/app.ts` — or `react-dom/client` directly — named nothing forbidden, loaded React, and
ran green. The node vitest project now refuses to resolve `react`, `react-dom` and
`@statewalker/ui.view.shadcn`, naming the rule; B0 imports each through a variable on every run and
asserts the refusal, so removing the plugin fails B0. The Vite build a node test runs
(`emitted-css.test.ts`) is unaffected: `build()` uses `vite.config.ts`'s plugins, not the test
project's.

### D20 — A view calls only view-side mutators; the split is derived, default-deny · **superseded** (S4 / S1), found in review

"The view writes only `input`" was a convention: a view holds the outer model and can call
`replaceTodos`. A reviewer's `model.replaceTodos(model.todos)` in the list view passed B0, the type
checker and every browser test — a `toJSON()` snapshot cannot see a write of equal data. B0 now fails
a `todo-ui` source that names any model method outside an explicit list of what a view may call. The
forbidden set is not listed: it is read at run time from the model classes `@todo/app/models`
exports, so a *prototype* method added to a model later is forbidden to views until someone adds it
to the list. Only prototype methods are collected: a function-valued instance field (the shape the
change channels use), a getter or setter, or a method of a model class `@todo/app/models` does not
export is not, and is therefore allowed to views by default.
The object split between `model` and `model.input` is what makes this checkable, not what enforces
it.

The same review found B0's model-rule exemptions keyed by **suffix** (`-model.ts`, `view-adapter.ts`)
in any layer — which exempted `use-model.ts` from the notify and field-write rules, and would have
exempted any `todo-ui` file named `*-model.ts`. They are now keyed by location.

Superseded: the view is handed the `view` facet and nothing else (S4); B0 checks it never names
`control`.

### D21 — `bootstrap` is a saga on failure too · adopted, found in review

A `registerViews` that threw left the command defaults registered, with no handle for the caller to
release them — `todos:add` was still answered by the orphan. `bootstrap` now starts the registry's
cleanup and rethrows. The unwind is asynchronous, so it completes within the turn rather than before
the throw; `bootstrap` stays synchronous because every caller relies on it returning a handle at once.

### D22 — Focus returns to where it was when a view that held it closes · adopted, found in review

A command-opened dialog has no trigger, and Radix returns focus to the trigger — so every answered
confirm left focus on `<body>`. `show()` restores the element focused at mount, but only when the
unmount is what lost focus; a view closing while the user is elsewhere leaves focus alone.

### D23 — B0's view-suite and composition-root rules bind the React entry · adopted, narrows an earlier rule

"A suite importing `@todo/ui` may not import `@todo/core`" also bound protocol suites taking only
`@todo/ui/adapter`, and the composition-root rule counted the adapter as the ui layer. Together they
forced a hand-rolled `seededApi()` into three suites and a copy of the `todos:add` declaration into
one. Both rules now bind the view layer's **React entry** (`@todo/ui`, or a view by path): a suite that
renders views still may not import the core, and nothing but `src/app.ts` may wire the core to the
React views. A headless harness over the adapter uses the real `MemTodoApi` and `todosAdd`.

---

## The signals copy

### S1 — Signals behind one alien-shaped contract, one import point · adopted

Five functions, `lib/signals/contract.ts`, implemented by `alien.ts` and `preact.ts`; the app
imports `@todo/signals` = `deps.ts`, one line. B0 fails if either library is imported anywhere else.
Swapping libraries is editing that line and running the ladder.

### S2 — What the contract guarantees, and the five things it leaves open · adopted

Eight guarantees, pinned on both libraries by B1's contract suite. Five behaviours differ (ARCHITECTURE
§12): four are left open, and the suite records each per library, so an upgrade that changes one
fails where it is named; the fifth — effect ownership — is normalized (S3) and pinned as guarantee 8
instead. The app relies on none of the five, hence two rules: no effect throws, and a reaction must
converge.

### S3 — Effects are owned by nobody · adopted

alien disposes an effect created during another effect's run when that effect re-runs; preact does
not. `alien.ts` creates every effect untracked, so both behave like preact — a controller activated
from inside some reaction must not die with it.

### S4 — Models are factories returning two frozen facets · adopted

`{ view, control }` over signals in a closure. It replaces D5's field-write grep, D16's forwarding and
D20's view-side method grep with facts about scope and references. Frozen, because a facet is shared.

### S5 — `useValue`'s cache is keyed by the read and the value · adopted

The cache answers only for the same `read` while `isEqual` holds. An inline `read` misses once per
render and never twice within one, which is what React's loop guard needs; a component re-pointed at
another model samples that model — the parent's regression, kept.

### S6 — The ladder runs on both libraries · adopted

B1–B5 run once per library as Vitest projects; a canary per project proves `@todo/signals` resolved
to the library it names. The preact run is the cycle detector alien lacks.

---

## Deferred

| Item | Why deferred |
| --- | --- |
| **B7** — a persistent `TodoApi` | the seam exists; persistence is a separate rung |
| **B8–B9** — extracting `app-kit` | gated on the Files Manager being ported onto it as a *second* caller, so the substrate is not extracted from one app |
| **One reconcile loop per controller blocks behind an open dialog** | while the clear-completed confirm is open, a queued add, a toggle and a refresh sit undrained until it is answered. The modal hides it here; a host routing `todos:add` through an approval dialog, or the Files Manager's conflict dialogs, would freeze the whole controller. Likely direction: await view-settled commands **outside** the reconcile loop and feed each answer back in as an edge. Recorded in `list-controller.ts` and ARCHITECTURE §6 |
| **The token and bootstrap are shaped around `ListController`** | B0 hardcodes `list-controller.ts` as the one controller allowed to import `views-ready`; `AppHandle` has only `createList`; `MenuController` takes no token and emits `ui:show-menu` with no proof the view layer exists. A second controller must edit B0's list (DEVELOPING, *Add a controller*). Generalise when the Files Manager brings a second controller |
| `expectEveryEdgeHonoured` helper | specified, not built: no view here can produce two distinct payloads in one tick, so it has no honest caller until the dock shell |
| a right-click menu gesture | `MenuView` renders and is tested, but no list gesture opens it yet |
| a computed facet name | *todo-ui never names the control facet* reads names: `const c = model["con" + "trol"]` walks past it. B1's facet key-set test is what would notice a member added to work around it |
| a mutator that writes two signals without `batch` | nothing checks that a mutator writing two signals uses `batch`; none does today |
| **M8** — toasts overlap; the menu is not at the pointer | every `ui:notify` renders at one fixed position (bottom right), so two toasts at once overlap; `MenuView` sits at a fixed spot — centred horizontally, a third of the way down — not at the pointer. Cosmetic, and the menu has no gesture opening it yet |
| the upstream `claimed` issue | must be filed on `@statewalker/shared-commands` before this substrate is published |
| bundle size (624 kB) | the kit is imported through one barrel that pulls five Radix packages; not relevant to a blueprint yet |
| the model list can lag the backend | the clear-completed skip reads the loaded list, so completed items not yet loaded are not offered |
