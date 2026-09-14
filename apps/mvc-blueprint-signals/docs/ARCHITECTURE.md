# Architecture

How this app is put together, and why each piece has the shape it has. Every example is taken
from the code; where the obvious design was tried first and failed, that is said too, because the
failure is usually the most useful part.

- [1. Three layers, one bus](#1-three-layers-one-bus)
- [2. Commands](#2-commands)
- [3. Models](#3-models)
- [4. Change: dependencies instead of channels](#4-change-dependencies-instead-of-channels)
- [5. Input: three classes of field](#5-input-three-classes-of-field)
- [6. Controllers](#6-controllers)
- [7. Views are command handlers](#7-views-are-command-handlers)
- [8. Bootstrap, and why the order is a token](#8-bootstrap-and-why-the-order-is-a-token)
- [9. Lifetimes: the registry](#9-lifetimes-the-registry)
- [10. Failure](#10-failure)
- [11. The composition root](#11-the-composition-root)
- [12. The signals contract](#12-the-signals-contract)

---

## 1. Three layers, one bus

| Layer | Directory | Knows | Never knows |
| --- | --- | --- | --- |
| **core** | `lib/todo-core` | the domain record, the `TodoApi` port, the `todos:*` declarations and their default handlers | any `ui:` command, the app, the DOM |
| **app** | `lib/todo-app` | models, controllers, `bootstrap`, the `ui:*` declarations | React, the DOM, any view |
| **ui** | `lib/todo-ui` | React views, `useValue`, the view adapter | a controller, `bootstrap`, `todo-core` |

The rules that make this real:

- **Controllers own the I/O and the orchestration. They never see a view.**
- **Models hold data and notify. They perform no action.**
- **Views know only models. Nothing else. Never.**
- **The only way across a layer boundary is a command.**

`B0-boundaries/tests/boundaries.test.ts` enforces the parts of these that are facts about the
files — who imports what, who names the bus, who creates signals and effects, which facet a view is
handed — and fails the run on a violation, as far as its patterns reach. Two are design rules kept by review, not
by a test: nothing checks that a model "performs no action", and reads cross from a controller to the
core through `TodoApi`, not through a command (§6). See
[DEVELOPING.md](DEVELOPING.md#the-rules-and-what-enforces-them) for each rule, its test, and what walks
past it.

The layers are directories behind aliases (`@todo/core`, `@todo/app`, `@todo/ui`), not packages.
That was a deliberate reversal: an earlier design used three packages "because that is the split a
boundary suite can police". It is not true — the sibling `fm-protos` is one package and its grep
suite polices it perfectly well. What lets a boundary rot is **not grepping it**, not its layout.

## 2. Commands

`@statewalker/shared-commands` provides the bus. A **declaration** names a command and types it:

```ts
// lib/todo-core/src/declarations.ts
export const todosAdd = Command.required("todos:add")
  .input(z.object({ title: z.string().min(1) }))
  .output(z.object({ id: z.string() }))
  .label("Add")
  .description("Add a new todo")
  .build();
```

`commands.call(todosAdd, { title })` returns a `Command` **synchronously**, with `.promise`,
`.resolve()`, `.reject()` and `.settled`. A listener registered with `commands.listen(decl, fn)`
answers it:

| A listener returns | Meaning |
| --- | --- |
| a `Promise<R>` | claims the command; the bus settles it when the promise does |
| `true` | claims it but settles nothing yet — someone will call `resolve`/`reject` later |
| nothing | **observe only** — does not claim |

`Command.required` means that if nobody claims, the call **rejects** — with `no-handlers` if nobody
was listening at all, `not-claimed` if listeners ran and all declined. Never a promise that hangs.

### Every operation is overridable

The core registers its own handler for every `todos:*` command **at negative priority**. A host
overrides any of them by listening at priority 0 — to route delete to a trash list, add an approval
step, or block writes:

```ts
// lib/todo-core/src/todo-commands.ts
const fallback =
  <P, R>(handler: (cmd: Claimable<P, R>) => Promise<R>): CommandListener<P, R> =>
  (cmd) => {
    const c = cmd as Claimable<P, R>;
    return c.claimed ? undefined : handler(c);
  };
```

**Negative priority orders listeners; it does not stop them.** A fallback runs even after a host
has claimed, so it must decline explicitly — which is what reading `claimed` does. That field is
set by the bus but declared only on an unexported internal type, which is why this app names it
(`Claimable`) and guards it with a test (`B2-commands/tests/claimed-contract.test.ts`).

### The handlers are thin

Each default is one line of delegation to `TodoApi`:

```ts
commands.listen(todosAdd, fallback(async (cmd) => {
  const todo = await api.add(cmd.payload.title);
  return { id: todo.id };
}), at);
```

The command layer decides **whether** an operation happens and who may override it. The api
decides **how**. Either can be swapped without touching the other.

### Applicability is a command too

A command registry is a flat catalog with no notion of "which commands apply to this selection". So
there is a command for exactly that — `todos:resolve-actions` — whose default offers the whole
`todos:` namespace and which a host can narrow. The menu is built from it (see §6).

## 3. Models

A model is a **factory returning two frozen facets** over signals it keeps in its closure:

```ts
// lib/todo-app/src/todo-model.ts
export function createTodoListModel(): TodoListModel   // { view, control }
```

| Facet | Holds |
| --- | --- |
| `view: TodoListView` | reads — `visible`, `filterDraft`, `showDone`, `lastOutcome`; the view-side mutators — `setFilter`, `setShowDone`, `requestRefresh`, `requestClearCompleted`, `queueSubmit`, `requestToggle`, `requestRemove` |
| `control: TodoListControl` | `edges` — the reads the controller reacts to; `todos`; the drains `takePending`, `takeToggles`, `takeRemovals`; the result writers `replaceTodos`, `reportOutcome` |

Every read handed out is a `Read<T>` — a function with no write half. Both facets, and
`control.edges`, are frozen: a facet is shared, and unfrozen, `view.setFilter = …` would replace a
function for every holder.

### What the substrate makes a fact

- **Nothing outside a model can write a field.** The signals are in the factory's closure; no
  caller holds a writable one. (The parent enforced this with a grep over assignments.)
- **A view cannot reach the controller's side.** It is handed `view` — `ui:show-list` is declared
  over `TodoListView` — so `replaceTodos` is not something it can name. (The parent grepped the view
  layer for a derived list of forbidden method names.)
- **A write of the value already held notifies nobody** — contract guarantee 1.
- **`visible` is covered by construction.** It is a `computed` over `todos`, `filterDraft` and
  `showDone`; whatever reads it depends on all three. (The parent forwarded the input's query changes
  to the outer model by hand, and found the omission only in review.)

### What stays a rule

- **Arrays and objects are replaced, never mutated.** Change detection is by identity; an in-place
  `push` reaches no signal.
- **A mutator that writes two signals does so inside `batch`** — one notification per intention.
  None does today.
- **A mutator reads its own signals `untracked`,** so calling it from inside any reaction adds no
  dependency.

## 4. Change: dependencies instead of channels

The parent declared a **channel per meaningful change** (`onChangeNotifier`), so a subscriber was
woken only by the change it asked for. Signals do this by construction: an effect depends on exactly
what its last run read. The controller's effect reads its five edges and nothing else, so typing in
the filter does not wake it.

Three things to know before relying on it:

1. **It does not coalesce.** Two writes outside a `batch` wake an effect twice. Coalescing is the
   controller's job (§6).
2. **It compares by identity** (`===`), which is why arrays are replaced (§3).
3. **A read is a subscription only on the run that made it.** An effect — or a `computed` — depends
   on exactly what its last run read; a run that returns, or branches, before reading has no
   dependency on what it skipped, and a later change to that value never wakes it. `visible` used to
   read `showDone()` only inside the `.filter()` callback: with an empty `todos()` list `.filter()`
   never called the predicate, so `showDone` was never read and never became a dependency, and
   toggling "Show completed" against an empty list would stop filtering for good once items arrived.
   The fix (§3) reads every input — `filterDraft()`, `showDone()`, `todos()` — unconditionally,
   before any data-dependent branch.

What the parent's channels gave that tracking does not: a subscription you can grep. B0 cannot see
what an effect reads, so the controller's effect reads a declared `edges` object, and B1's
*each intent wakes only its own edge* pins which read each mutator moves.

## 5. Input: three classes of field

User input lives on the `view` facet's mutators and the `control.edges` reads — the same signals,
seen from two sides. Intent flows **in** through the view's mutators; results flow **out** through
`control.replaceTodos` and `control.reportOutcome`. The controller's effect reads the edges and
writes the results, so its results cannot wake it. It writes an edge only to **drain** it — each
`take*()` replaces a queue, inside a run, where the in-flight guard (§6) turns any re-run into a
no-op.

Every input field belongs to one of three classes, and the class decides what the controller must do:

| Class | Fields here | The controller must |
| --- | --- | --- |
| **Level** | `filterDraft`, `showDone` | reconcile to the latest value |
| **State-latest edge** | `refreshCount`, `clearCompletedCount` | **coalesce**: many presses, one action, newest state |
| **Event edge** | `pending`, `toggles`, `removals` | **honour every one**: N presses are N actions |

The distinction is the most valuable thing this blueprint produced, and the File Manager it came
from never drew it — every edge there was state-latest, so the difference never showed.

**An event edge must carry its payload.** A counter beside a level field cannot: set
`title = "a"; submitCount++; title = "b"; submitCount++` and the counter records two events while
the model has destroyed the first title. So an event edge is a **replaced queue**:

```ts
queueSubmit: (title: string) => append(pending, { title }),   // a new array, always
takePending: drain(pending),                                  // replaced, silent when empty
```

**Clear-completed is state-latest on purpose.** Two quick presses must open one confirm dialog, not
two. Toggle and delete are event edges on purpose: two toggles on two rows are two actions, and
losing one is a bug.

## 6. Controllers

`ListController` owns the api and the bus, and never sees a view. It subscribes with **one effect**
over the model's `control.edges` and nothing else, and its whole job from there is one idempotent,
re-entrant loop, `_reconcile()`:

```ts
// lib/todo-app/src/list-controller.ts
const { edges } = this._model.control;
register(
  effect(() => {
    // These reads ARE the subscription: every edge, read first and unconditionally.
    edges.refreshCount();
    edges.clearCompletedCount();
    edges.pending();
    edges.toggles();
    edges.removals();
    untracked(() => void this._reconcile());
  }),
);
```

### Coalescing is leading + trailing

A watermark alone **cannot** coalesce. A signal write wakes the effect synchronously, so five
`requestRefresh()` calls in one tick run it five times before the first reload's `await` suspends —
all five pass the watermark check and five reloads start. The first controller written for this app
did exactly that and failed its own test.

The fix is the `_reconciling` guard: re-entrant calls return immediately, and the running pass
**loops**, re-reading the counters after every await. The first pulse reloads at once; everything
arriving mid-flight folds into one follow-up carrying the newest state. **Five bumps are two
reloads — not five, and never one with a bump lost.**

### One loop — so everything waits behind an open dialog

The same guard has a cost, and it is not solved here. Every edge is drained by the one loop, step
after step, and a step may await a command that only a **view** settles. While the clear-completed
confirm is open, a queued add, a toggle and a refresh all sit undrained until the user answers:
their wakes fold into a run that is parked on the dialog.

In this app the modal hides it — nothing behind it can be pressed. It would not hide it for a host
that routes `todos:add` through an approval dialog, or for the Files Manager's conflict dialogs: one
open question would freeze the whole controller. The likely direction is to await view-settled
commands **outside** the reconcile loop and feed each answer back in as an edge. It is recorded as
deferred in [DECISIONS.md](DECISIONS.md#deferred).

### Reads go through the api; writes go through commands

The controller calls `api.list()` directly but writes via `commands.call(todosAdd, …)`. Writing
through the bus lets a host override the operation without the controller knowing. Reading is not
an operation anyone overrides.

### It shows its own panel

`activate()` emits `ui:show-list(model)` and holds the command for its whole life — a long-lived
view. `dispose()` settles it, and the view unmounts. The controller does not know a view exists; it
knows a command was answered.

### It orchestrates views like any other command

Clear-completed is a chain a controller drives end to end:

```
requestClearCompleted()  ─►  ui:show-dialog:confirm  ─►  todos:clear-completed  ─►  ui:notify
     (state-latest edge)       (short-lived view)          (overridable command)      (fire-and-forget view)
```

With nothing completed, it asks nothing — no dialog, no command, no toast. That is decided in the
controller, not left to the view disabling its button, because a host or an agent can raise the
intent too.

### The menu is built by the controller

Declarations carry `label` and `icon`, but they live in the registry, and a view may not read the
registry. So `MenuController` is the one that copies them into a `MenuModel` — after
`todos:resolve-actions` says which apply — and the menu is never hand-written.

## 7. Views are command handlers

There is no view registry and no "mount panel" API. A controller emits `ui:show-list(model)`; the
**view adapter** claims it and renders; the view unmounts when the command settles — **from either
side**. The user settles by acting; the controller settles to force-close.

Panels, dialogs, toasts and menus are one mechanism at different lifetimes:

| View | Command | Lifetime |
| --- | --- | --- |
| the list | `ui:show-list` | long-lived — settled only by the controller's dispose |
| confirm | `ui:show-dialog:confirm` | short — settled by the user's answer |
| toast | `ui:notify` | self-settling after a timeout |
| menu | `ui:show-menu` | short — settled by a pick or Escape |

### The adapter is keyed on the declaration

```ts
adapter.on(uiConfirm, ({ model, settle }) => { /* render; return a cleanup */ });
```

The key *is* the declaration, so the model and result types come from its own schemas — each view
keeps a typed model and a typed result. **A view is identified by its command key and nothing
else**: `openViews()` reports `ui:show-list`, never `"list"`. The earlier design kept a separate
`kind` alongside the declaration — two names for one thing, which can disagree.

A renderer **claims** by returning a cleanup (or by settling synchronously). A renderer that returns
nothing without settling declines, and the caller sees `not-claimed`. A declaration nobody
registered has no listener at all, and the caller sees `no-handlers` — the louder, more accurate
diagnosis for a wiring bug.

### A view knows only its model

```tsx
// lib/todo-ui/src/views/list-view.tsx
export function ListView({ model }: { model: TodoListView }) {
  const rows = useValue(model.visible, shallowEqual);
  // ...
  <Input onChange={(e) => model.setFilter(e.target.value)} />
  <Checkbox onChange={() => model.requestToggle(todo.id)} />
}
```

Every gesture is a view-side mutator call on the `view` facet. The view never assigns a field, and
cannot call a controller-side mutator — it was never handed one — and never guesses an outcome: a
ticked row stays unticked until the controller's `replaceTodos` says otherwise. Its one piece of
local state is the add form's half-typed title, which is not model state until it is submitted.

### Focus goes back where it was

A command-opened dialog has no trigger, and Radix returns focus only to a trigger — so every
answered confirm used to leave the keyboard on `<body>`. `show()` in `register-views.tsx` records
the focused element when a view mounts, and when the view closes, puts focus back there **if**
closing this view is what lost it (the focused element was one the unmount removed). A view that
closes while the user is elsewhere — a toast expiring as they type — leaves focus alone.

### `useValue` is the whole React binding

```ts
useValue(read, isEqual = Object.is)
```

It wraps `useSyncExternalStore` using the signals contract alone. The subscription is an effect that
calls `read()` — so the component depends on exactly what `read` reads — and tells React inside
`untracked`, because React calls `getSnapshot` synchronously from its change callback. The snapshot
is `untracked(read)`, cached: for the same `read`, while `isEqual` holds, the previous reference is
returned, which is what keeps an inline derivation returning a fresh array from looping React. A
`read` that throws is caught in the effect — it would otherwise throw out of whoever wrote the
signal — and rethrown from `getSnapshot` into React's error boundary.

Pass facet reads (`model.visible`): they are stable functions, so the component subscribes once.

### The adapter is headless

`view-adapter.ts` imports the bus and the registry and nothing else — no React. It is reachable as
`@todo/ui/adapter`, so the headless suites that test the view *protocol* never load React DOM. They
used to, by accident, until a review planted a `document` access in a view and four headless suites
broke at import.

Naming the adapter is not the same as not loading React, and a grep can only check the naming: a
node suite that imported `src/app.ts` named no `@todo/ui` and loaded every view. So the node vitest
project refuses to **resolve** `react`, `react-dom` or `@statewalker/ui.view.shadcn` — the import
fails, naming the rule — and B0 proves on every run that the refusal is in place. It refuses what
Vite resolves: a package under `node_modules` that imported React by itself, or a `createRequire`
call, would get past it. No current dependency does.

## 8. Bootstrap, and why the order is a token

The order is **bus → view handlers → controllers**. It is what makes `Command.required` correct
everywhere: when a controller emits `ui:show-list`, a missing handler is a wiring bug, not a race.

The sibling app wrote this rule in a comment — *"the caller registers view handlers BEFORE calling
this"* — and enforced it with nothing. A `bootstrap()` function does not enforce it either: it
orders its own body, but the controller class is still exported, and anyone can construct and
activate one with no view layer present.

So the order is a **token**:

```ts
// lib/todo-app/src/bootstrap.ts
register(registerTodoCommands(commands, api));
let viewsCleanup;
try {
  viewsCleanup = registerViews(commands);
} catch (error) {
  void cleanup();                          // unwind what already succeeded (§9)
  throw error;
}
if (viewsCleanup) register(viewsCleanup);
const ready = ViewsReady._mint();          // minted only now

// lib/todo-app/src/list-controller.ts
activate(ready: ViewsReady): void {
  if (!(ready instanceof ViewsReady)) throw new Error("…before the view layer was registered…");
  // ...
}
```

`bootstrap` returns a **capability**, not a fixed set of controllers — `createList(model)` hands
back `{ controller, release }`. The Files Manager opens and closes panels at run time, and the dock
shell loads mini-apps long after bootstrap returned; both need controllers created later, and both
still need the order. Once `dispose()` has been called, `createList` throws: there is no view layer
and no command default left for a controller to use.

**What makes the token unforgeable is module confinement, not the private constructor.** A private
constructor is a compile-time fiction: `Object.create(ViewsReady.prototype)` passes `instanceof`
without calling it, and a public static `_mint()` is callable by anyone who holds the class. So the
`@todo/app` barrel exports `ViewsReady` as a **type only**, and B0 fails the run if `_mint` appears
in any file but `views-ready.ts` and `bootstrap.ts`, or if any file but `bootstrap.ts`,
`list-controller.ts` and the barrel (type-only) imports `views-ready` at all.

Be precise about the strength of this. It stops **mistakes** — the honest caller reaching for a
controller directly, which is what actually happens. It does not stop deliberate evasion from inside
an allowed file. No mechanism in one JavaScript realm can.

And be precise about its reach: it is shaped around **one** controller. B0's list of files that may
import the token names `list-controller.ts`, so a second controller fails B0 until that list is
edited (DEVELOPING.md, *Add a controller*); `AppHandle` has only `createList`; and `MenuController`
takes no token at all, so nothing proves the view layer was registered before it emits
`ui:show-menu`. Generalising it is deferred ([DECISIONS.md](DECISIONS.md#deferred)).

## 9. Lifetimes: the registry

Every subscription, listener and disposer is owned by `newRegistry` from
`@statewalker/shared-registry` — never a hand-rolled array of off-functions.

```ts
const [register, cleanup] = newRegistry();
register(commands.listen(todosAdd, handler, at));  // listen() returns its own off
// ...
await cleanup();
```

| It gives you | Which matters because |
| --- | --- |
| **LIFO unwind** | Register commands, then views, then controllers — cleanup releases controllers, then views, then commands, with nobody sequencing it. |
| **Idempotent disposers** | A controller released on its own and again by the app is safe. |
| **Errors do not stop the unwind** | One throwing listener cannot strand the rest, unlike `for (const off of offs) off()`. |
| **Async** | So `dispose()` is `async` everywhere, and callers await it. |

`register()` also returns a per-registration disposer, which is how `createList` hands back a
`release()` that frees one controller without tearing the app down.

### A step that fails unwinds the steps that succeeded

This is the **saga** shape, and it covers failure as well as teardown. If `registerViews` throws,
`bootstrap` has already registered the command defaults — and the caller gets no handle to release
them. So `bootstrap` starts the registry's cleanup and rethrows. The unwind is asynchronous (the
core's disposer is itself a registry's cleanup), so it is under way when the error reaches the
caller and done within the turn; after that, `todos:add` finds no handler. The dock shell needs
exactly this for a mini-app that fails halfway through loading.

### `dispose()` is write-quiescent, not call-quiescent

When `ListController.dispose()` resolves, the controller will **never write the model again** —
every await is followed by a `_disposed` check. It does **not** wait for an api call already in
flight; that call may finish afterwards, and its result is dropped.

The stronger guarantee was tried and withdrawn. Waiting for in-flight work deadlocks: the registry
unwinds controllers *before* the view layer, so a run awaiting a view-settled command — a host
routing `todos:add` through an approval dialog — waits for a dialog nobody can close any more.

## 10. Failure

Controller work runs inside `_reconcile()`, fired with `void` from the effect — so a
rejection escaping it has nowhere to go but the process, and nothing reaches the user. Therefore
**nothing escapes**. Every failure is caught where it happens and reported through the model:

```ts
if (didWork && !this._disposed) this._model.control.reportOutcome(failure);
```

`lastOutcome` is what the list view shows as its error line.

The watermark rule, stated once: **a watermark moves once the user's intent is consumed.** Two
refinements of what "consumed" means, each learned from a defect:

- **For work with no question in it, that is when the work landed.** A failed reload leaves
  `_handledRefresh` where it was, so the refresh is still owed and one later bump repays it. (It used
  to advance *before* the await, which left the model stale forever while claiming the work was done.)
- **For an intent that asks the user a question, the answer is what consumes it.** A clear-completed
  that fails *after* the user confirmed is reported, and **not** retried — retrying would re-open a
  dialog the user already answered, triggered by whatever unrelated edge woke the loop next. An
  invisible reload is safe to retry; a modal question is not.

A missing view handler — the one failure that means the app is miswired — surfaces through
`controller.panelSettled`, a promise that resolves with data rather than rejecting, which the
composition root turns into a visible error and a `console.error` (§11).

## 11. The composition root

`src/app.ts` is the **only** module that imports the core, the app and the view layer's React entry
together. B0 enforces it. A headless suite that boots `bootstrap` over a real `MemTodoApi` and a
`ViewAdapter` from `@todo/ui/adapter` is not counted: it is a protocol harness that can render
nothing, and counting it made such suites hand-roll copies of the core.

```ts
export function startApp(root: HTMLElement, options: StartOptions = {}): RunningApp {
  const commands = new Commands();
  const app = bootstrap({
    commands,
    api: options.api ?? new MemTodoApi([...seedTodos]),
    registerViews: (options.registerViews ?? registerViews)(root),
  });
  const { controller } = app.createList(createTodoListModel());
  void controller.panelSettled.then((outcome) => {
    if (outcome.ok || disposed) return;
    console.error("[mvc-blueprint-signals] the todo list could not be shown:", outcome.error);
    failure = renderFailure(root, outcome.error);
  });
  // ...
}
```

`main.tsx` is only the page entry — styles, the root element, one call to `startApp`. It is split
out so the end-to-end suite boots exactly what `pnpm dev` serves.

The failure is rendered in **plain DOM, not React**: it reports that the view layer is broken, so it
must not depend on the view layer working.

### Styling

```css
/* src/index.css */
@import "tailwindcss";
@import "@statewalker/ui.view.shadcn/styles";   /* the kit finds its own classes */
@source "../lib/**/*.tsx";                       /* this app's own views */
@theme inline { /* … */ }
```

Two traps, both of which cost time:

1. **Do not hand-roll what the kit exports.** Tailwind v4 skips `node_modules` when looking for
   classes, so the kit's classes are never emitted unless you point at them. The kit ships its own
   `@source` globs as `./styles`; import that. The neighbouring `byok-config-prototype` instead
   wrote `@source "../../../packages/ui.view.shadcn/..."` — a path that does not exist in this repo.
   A dead `@source` glob emits nothing and reports no error, so the app renders unstyled with every
   build green. `B6-app/tests/emitted-css.test.ts` builds the app and asserts a class that exists
   only in the kit's source reached the CSS; it fails for a missing import **and** for byok's glob.
2. **A `@theme` block must live in the CSS file Tailwind processes** — the one that
   `@import "tailwindcss"`. It does not merge from a separately-processed entry.

## 12. The signals contract

The app imports its signals from `@todo/signals` — `lib/signals/deps.ts`, one line:
`export * from "./alien.js"`. What it imports is a contract of five functions, alien-signals' own
shape:

```ts
signal<T>(initial: T): Signal<T>          // s() reads, s(v) writes
computed<T>(fn: () => T): Read<T>
effect(fn: () => void): () => void        // runs now; returns stop; owned by nobody
batch<T>(fn: () => T): T
untracked<T>(fn: () => T): T
```

`alien.ts` is nearly a re-export; `preact.ts` wraps `.value` into call syntax. Swapping libraries is
editing that one line. B1's contract suite runs both against the nine guarantees the app relies on (the ninth,
synchronous propagation outside a batch, is pinned by test 4's unbatched half).
Five behaviours differ between the libraries: four are left open, and the suite records each per
library, so an upgrade that changes one fails where it is named; the fifth — an effect created
inside another effect's run — is normalized instead (`alien.ts` creates every effect untracked) and
pinned as guarantee 8:

| Behaviour | alien-signals | preact |
| --- | --- | --- |
| an effect writes a signal it tracks (a drain) | not re-run | re-run once |
| an effect that never settles | runs once, silent | throws `Cycle detected` |
| an effect created inside another effect's run | normalized: survives | survives |
| one effect throws during a flush | the rest is skipped | the rest runs, then it rethrows |
| a write inside effect A that effect B tracks | B runs during the write | B runs after A |

The app relies on none of them, and two rules follow: **no effect throws** (each catches what it can
raise), and **a reaction must converge** — alien will not tell you when one does not. The ladder runs
on both libraries, so the preact run is the cycle detector.
