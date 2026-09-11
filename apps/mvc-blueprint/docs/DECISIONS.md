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

No caller assigns a field or calls `notify()`. One intention, one notify, owned by the model.
Enforced by B0. See ARCHITECTURE §3.

### D6 — Input fields come in three classes · adopted

Level, state-latest edge, event edge. The class decides the controller's obligation — reconcile,
coalesce, or honour every one — and an event edge must carry its payload, so it is a replaced queue,
not a counter. This distinction did not exist in the design this blueprint came from; every edge
there was state-latest, so the difference never showed. See ARCHITECTURE §5.

### D7 — Models expose named change channels · adopted

`onChangeNotifier` per meaningful change. A subscriber is woken only by the change it asked for.
Bare `onUpdate` is allowed only inside a model and in `use-model.ts`. See ARCHITECTURE §4.

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
should write an *outcome* instead); use a named channel so it is not woken by its own writes;
**compare before writing in the mutator**, which raises no notify at all for an unchanged value and
survives `await`; use a watermark for edges; and for a genuinely shared model (peer sync), carry the
writer's identity in the data and skip your own.

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
  build if any other file mints or imports it. It stops mistakes, not deliberate evasion — no
  in-realm mechanism can.

### D12 — `bootstrap` returns a capability, not a controller set · adopted

`createList(model)` returns `{ controller, release }`. Constructing every controller inside
`bootstrap` cannot serve either later consumer: the Files Manager opens and closes panels at run time,
the dock shell loads mini-apps after bootstrap returned. `release()` frees one controller without
tearing the app down — without it, a shell opening and closing panels would accumulate a closure per
panel until app teardown.

### D13 — `dispose()` is write-quiescent, not call-quiescent · adopted, after a deadlock

First version: dispose did not wait at all, and a disposed controller wrote the model 60 ms later.
Second version: dispose waited for in-flight work — and **deadlocked**, because the registry unwinds
controllers before views, so a run awaiting a view-settled command (an approval dialog) waited for a
dialog nobody could close. Final: dispose does not wait, and every await is followed by a
`_disposed` check. No write after dispose resolves; an api call already in flight may still finish,
and its result is dropped.

### D14 — Nothing escapes a `void` · adopted

Controller work is fired with `void`, so every failure is caught where it happens and reported
through `reportOutcome`. A watermark moves only when its work landed. The first version had no error
policy at all: a rejected add was an unhandled rejection and a dropped item, and a failed reload left
the model permanently stale while its watermark claimed the work was done.

### D15 — A question answered is an intent consumed · adopted

A clear-completed that fails *after* the user confirmed is reported and **not** retried. The general
rule ("a watermark moves only when the work landed") was built for invisible, idempotent work;
applied to a modal question it re-prompts a user who already said yes, triggered by whatever
unrelated action woke the controller next. And with nothing to clear, no question is asked at all —
decided in the controller, because a host or agent can raise the intent too.

### D16 — A model's `onUpdate` covers its derived getters · adopted, found in review

`visible()` reads the input sub-model's filter fields, which the outer model's `onUpdate` did not
cover — so a view bound to `visible()` would not re-render on a filter change. The first view worked
around it by subscribing to the filter fields itself; the fix went into the model, which now forwards
query changes. See ARCHITECTURE §3.

### D17 — The headless adapter is a separate entry · adopted, found in review

`@todo/ui/adapter` exposes the view adapter without React. The node suites that test the view
protocol used to import `@todo/ui`, which also exported the React views — so they loaded React DOM
and the whole kit by accident, and would have broken the day any view touched `document` at import.

### D18 — Import the kit's own styles · adopted

`@import "@statewalker/ui.view.shadcn/styles"`, never a hand-written `@source` into the kit. The
neighbouring prototype hand-wrote a glob to a path that does not exist; a dead glob emits nothing and
reports nothing. A build-level test asserts a kit-only class reaches the CSS.

---

## Deferred

| Item | Why deferred |
| --- | --- |
| **B7** — a persistent `TodoApi` | the seam exists; persistence is a separate rung |
| **B8–B9** — extracting `app-kit` | gated on the Files Manager being ported onto it as a *second* caller, so the substrate is not extracted from one app |
| `expectEveryEdgeHonoured` helper | specified, not built: no view here can produce two distinct payloads in one tick, so it has no honest caller until the dock shell |
| a right-click menu gesture | `MenuView` renders and is tested, but no list gesture opens it yet |
| aliased field writes | the static grep cannot see `const i = model.input; i.x = …`; closed for views by the browser snapshot tests, not for controllers |
| the upstream `claimed` issue | must be filed on `@statewalker/shared-commands` before this substrate is published |
| bundle size (624 kB) | the kit is imported through one barrel that pulls five Radix packages; not relevant to a blueprint yet |
| the model list can lag the backend | the clear-completed skip reads the loaded list, so completed items not yet loaded are not offered |
