# Developing

The rules this code keeps, what enforces each one, and how to add to it without breaking them.
Read [ARCHITECTURE.md](ARCHITECTURE.md) first for *why* the rules exist.

## Principles

1. **If a rule matters, a test fails when it is broken.** A rule in a comment is a wish; a rule in
   `B0-boundaries` is a fact — exactly as far as its patterns reach, and no further. Before you add
   a rule to this list, add the test, and write down what walks past it.
2. **Headless first.** Prove it in Node if you can. The browser is for what only a browser can prove.
3. **Test first, and watch it fail.** A test you have never seen fail is not evidence — this codebase
   has shipped roughly a dozen tests that looked right and could not fail. See [TESTING.md](TESTING.md).
4. **Fix a defect where it lives.** When a view had to work around a model, the fix went into the
   model, not into every view that would have rediscovered it.
5. **Comments explain why.** The code says what. A comment earns its place by saying why this shape
   and not the obvious one — especially when the obvious one was tried.

## The rules, and what enforces them

Every rule below is a test in `B0-boundaries/tests/boundaries.test.ts` unless noted. The suite reads
the source tree **recursively** (a guard test fails if it ever stops), strips comments, and matches.
It also carries **negative controls**: fixtures of known-bad code that each rule must reject, so a
rule weakened by a careless edit fails loudly rather than passing everything.

A grep checks spelling, not meaning. Each row says what the pattern is; where something walks past
it, the row or the note under the table says what.

### Layering

| Rule | Enforced by |
| --- | --- |
| `todo-core` names no `ui:` command in a string literal | B0 · *names no ui:\* command* |
| `todo-core` imports neither `todo-app` nor `todo-ui` — by alias **or** relative path | B0 · *imports nothing from todo-app or todo-ui* |
| `todo-core` and `todo-app` never name `document`, `window`, `HTMLElement` or `navigator` | B0 · *touches no DOM global* |
| `todo-app` imports no `todo-ui` | B0 · *imports nothing from todo-ui* |
| `todo-ui` reaches `todo-app` **only** through `@todo/app/models` — never a controller, `bootstrap` or the token | B0 · *reaches todo-app only through @todo/app/models* |
| `@todo/app/models` exports no controller, no `bootstrap`, no token — checked at run time, not by grep | B0 · *keeps @todo/app/models free of controllers…* |
| `todo-ui` never imports `todo-core` | B0 · *never imports todo-core* |
| only `todo-ui/src/view-adapter.ts` (that exact path) names `Commands` or `CommandsRegistry` | B0 · *touches the bus only in the adapter* |
| a suite that renders views — imports `@todo/ui` or a view, by alias or path — imports no `@todo/core`. A suite taking only `@todo/ui/adapter` tests the bus protocol and may use the real core | B0 · *holds for VIEW suites too* |
| `view-adapter.ts` imports `@statewalker/shared-commands` and `@statewalker/shared-registry`, and nothing else | B0 · *view-adapter.ts imports the bus and the registry — no React* |
| a **node** suite, and the test support it loads, names `@todo/ui` only as `@todo/ui/adapter` | B0 · *a node suite… takes @todo/ui only as @todo/ui/adapter* |
| a node suite cannot **load** `react`, `react-dom` or `@statewalker/ui.view.shadcn` — by name or through any module that imports them, `src/app.ts` included: resolution fails, naming the rule | the `mvc-blueprint-signals:headless` plugin in `vitest.config.ts`; B0 · *the node project refuses to LOAD React…* proves it is on, every run |
| only `src/app.ts` imports the core, the app and the view layer's **React entry** together | B0 · *only src/app.ts imports todo-core, todo-app and todo-ui's React entry together* |
| `vite.config.ts` reaches no `vitest` module, directly or through a local import | B0 · *vite.config.ts reaches no vitest module…* |

The headless plugin sees what Vite resolves — this app's sources and the specifiers they name. A
package under `node_modules` that imported React by itself would be loaded by Node and not caught;
none of the headless suites' dependencies does.

### Models and signals

| Rule | Enforced by |
| --- | --- |
| `alien-signals` is imported only by `lib/signals/alien.ts`; `@preact/signals-core` only by `lib/signals/preact.ts` | B0 · *each library is imported by exactly its own implementation file* |
| those two files are imported only by `deps.ts` and the contract suite | B0 · *the implementation files are imported only by deps.ts and the contract suite* |
| in `todo-app`, `signal(` `computed(` `batch(` appear only in `todo-model.ts`; `effect(` only in `list-controller.ts` and `model-kit.ts`; `untracked(` only in those three | B0 · *in todo-app, signals are created only in a model…* |
| in `todo-ui`, only `use-value.ts` imports `@todo/signals` | B0 · *in todo-ui, only use-value.ts reaches the signals* |
| `todo-ui` never names `control` or `TodoListControl` | B0 · *todo-ui never names the control facet* |
| the facets carry exactly the listed members, are frozen, share no function, and hand out reads that cannot write | B1 · *the two facets* |
| a write of the value already held wakes nobody | the contract suite (guarantee 1), and a B1 test per mutator |
| `todos` and each queue are replaced, never mutated | `expectReplacedNotMutated` in B1 |

**The limits.** A grep reads names: `const c = model["con" + "trol"]` walks past *never names the
control facet*, and the facet key-set test is what notices a new member. Nothing checks that a
mutator writing two signals uses `batch`; none does today. `use-value.ts`'s subscription tells React
inside `untracked(onStoreChange)` — defensive, not enforced: swap it for a bare `onStoreChange()` and
every current test still passes. Kept by review, not by a test.

### Wiring and lifetimes

| Rule | Enforced by |
| --- | --- |
| no disposer array named `offs` or `_offs` — the pattern checks that name only; that every registration goes through `newRegistry` is kept by review | B0 · *uses newRegistry rather than a hand-rolled disposer array* |
| `ListController.activate()` refuses a token `bootstrap` did not mint | `ViewsReady` + B4 · *refuses to activate a controller that did not come through the capability*; B0 · *mints only in views-ready.ts and bootstrap.ts* and *holds the ViewsReady CLASS only in bootstrap.ts and list-controller.ts*. `MenuController` takes no token (see [DECISIONS.md](DECISIONS.md#deferred)) |
| a `registerViews` that throws unwinds the command defaults bootstrap already registered, then rethrows | B4 · *unwinds what already succeeded when registerViews throws* |
| `createList()` after `dispose()` throws | B4 · *refuses createList() once the app is disposed* |
| `TodoApi`'s port files (`types.ts`, `*-api.ts`) spell no `Command`, `Model` or `BaseClass`, and import neither the bus, the model base nor the declarations | B0 · *keeps TodoApi and its adapters free of commands, models and the bus* |
| `ListController.dispose()` lands no model write after it resolves | B3 · *is WRITE-quiescent…* in `list-controller.test.ts`, and `dispose-liveness.test.ts` |
| `app.dispose()` resolves while a controller's run awaits a view-settled command — a host's approval dialog, or the controller's own confirm | `B3-controller/tests/dispose-liveness.test.ts` |
| when a view that held the focus closes, focus returns to where it was when the view opened | B5 · *an answered dialog returns focus…* and *a view that did not hold focus leaves it where it is*; B6 end to end |
| the shadcn kit's styles actually reach the built CSS | `B6-app/tests/emitted-css.test.ts` |

## Recipes

### Add a command

1. Declare it in `lib/todo-core/src/declarations.ts` with `Command.required`, a zod input and
   output, and a `label` (the menu reads it). Add it to `TODO_COMMANDS` if a user can invoke it.
2. Add a method to `TodoApi` (`lib/todo-core/src/types.ts`) and `MemTodoApi` — **async**, returning
   a Promise, knowing nothing of commands or models.
3. Register a default in `registerTodoCommands` (`todo-commands.ts`) through `fallback(...)` at
   `{ priority: -1 }`, delegating to the api in one line.
4. Test it in `B2-commands`: the default runs when nothing overrides (witness it on `api.calls`, not
   by inspecting a store that may look the same either way); a priority-0 override wins **and** the
   default did not also run.

### Add a user intent

A view can only reach a controller through the model, so every new gesture is a mutator.

1. **Classify it first** — this decides everything else:
   - does the latest value simply win? → **Level** (a plain field + a comparing setter)
   - should repeated presses collapse into one action? → **State-latest edge** (a counter, and a
     watermark in the controller)
   - must every press be honoured, each with its own data? → **Event edge** (a replaced queue plus a
     `take*()` that drains by replacement and is silent when empty)
2. Add the signal to `createTodoListModel` with a comment naming its class, its mutator to `view`,
   and — for an edge — its read to `control.edges` and its drain to `control`. Update the key lists
   in B1 · *the two facets*.
3. Test in `B1-models` with `watch` (test-support), which counts at the source.

### Handle an intent in the controller

1. Read its edge in the effect in `activate()`, with the other edges, before anything else.
2. Drain or read it inside `_reconcile()` — the existing loop, not a second one. That is what keeps
   coalescing and re-entrancy correct. The price: if the intent awaits a command a **view** settles
   (a dialog), every other edge waits with it until the user answers — see ARCHITECTURE §6.
3. Catch every failure where it happens and fold it into the run's `failure`; never let a rejection
   escape. Move a watermark once the intent is consumed: for work with no question in it, when the
   work landed; for an intent that asked the user a question, when the user answered.
4. After every `await`, check `_disposed` before writing the model.
5. Test in `B3-controller`: the class's obligation (coalesced? all honoured?), the failure path
   reported through `lastOutcome`, and no "Unhandled" anywhere in the output.

### Add a view

1. Declare its command in `lib/todo-app/src/ui-declarations.ts` (never in `todo-core`, which may not
   name `ui:`), with the view's model as input and the view's result as output. Export it from
   `models.ts`.
2. Write the component in `lib/todo-ui/src/views/`. Import from `@todo/app/models` and nothing else
   in `todo-app`. Take `{ model, settle }`. Bind with `useValue(model.x)` — and pass `shallowEqual`
   for any read returning an array or object. Turn every gesture into a call to a view-side mutator
   (one on the `view` facet); settle from the explicit gesture handlers (not from a derived "the
   dialog closed" event, which fires twice).
3. Register it in `register-views.tsx` with `show(adapter, mount, decl, render)`. `show` gives it its
   own container and root, and returns focus to where it was if the view held it when it closed.
4. Test it in `B5-views` (browser): it renders from its model; each gesture calls the right mutator —
   with the view handed a copy of its facet whose mutator is a `vi.fn()`, and `snapshotOf(model)`
   asserted unchanged; settling removes it from the DOM, checked where it actually lives (Radix
   dialogs render into `document.body`, not into your mount).

### Add a controller

Give it a constructor taking its model, the bus and the api; an `activate(ready: ViewsReady)` that
checks the token and registers its effect through a `newRegistry`; and an `async dispose()` that
sets `_disposed` first and runs the registry's cleanup **without awaiting in-flight work**. Expose
its creation as a capability from `bootstrap` returning `{ controller, release }` — do not export a
way to construct and activate it without the token.

**This recipe fails B0 as written, until you edit B0.** The token and bootstrap were shaped around
one controller (deferred — see [DECISIONS.md](DECISIONS.md#deferred)):

- B0 · *holds the ViewsReady CLASS only in bootstrap.ts and list-controller.ts* expects the files
  importing `views-ready` to be **exactly** `bootstrap.ts`, `index.ts` and `list-controller.ts`. A new
  controller that types `activate(ready: ViewsReady)` imports it too — even `import type` matches —
  so add its file to that test's expected list (and to its title). Keep it to controllers: every
  file on that list holds the class value, which is a forge.
- `AppHandle` has only `createList`. Add a `createX(model)` beside it in `bootstrap.ts`, built the same
  way — including its `disposed` check.
- `MenuController` is the other shape: it takes no token, so nothing proves the view layer was
  registered before it emits `ui:show-menu`. Do not copy that part.

## Commands you will use

```sh
pnpm test            # node suites
pnpm test:browser    # Chromium suites
pnpm test:B0         # just the boundaries — run it often
pnpm test:B3         # one rung
pnpm typecheck       # before every commit
pnpm dev             # the app (see README if it hits the file-watcher limit)
pnpm build && pnpm preview
pnpm vitest run --project node:preact   # one library
```

To see console output from **passing** tests — warnings you want to audit — run vitest with
`--reporter=default`; the default reporter here hides it.

## Dependencies

- `vitest` is pinned to **v5** in this app, not the workspace catalog's v4, because
  `@vitest/browser-playwright` requires it.
- `@statewalker/ui.view.shadcn` is published; import its `./styles`, never a path into its source.
- If `pnpm add` rewrites `pnpm-workspace.yaml` — reordering it, stripping its comments — revert that
  file. It has happened more than once in this repository, and it destroyed a documenting comment.
- `alien-signals` and `@preact/signals-core` are pinned exactly; a second copy of a signals library
  tracks independently and silently.
