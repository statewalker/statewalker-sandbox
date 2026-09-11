# Developing

The rules this code keeps, what enforces each one, and how to add to it without breaking them.
Read [ARCHITECTURE.md](ARCHITECTURE.md) first for *why* the rules exist.

## Principles

1. **If a rule matters, a test fails when it is broken.** A rule in a comment is a wish; a rule in
   `B0-boundaries` is a fact. Before you add a rule to this list, add the test.
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

### Layering

| Rule | Enforced by |
| --- | --- |
| `todo-core` names no `ui:` command | B0 · *names no ui:\* command* |
| `todo-core` imports neither `todo-app` nor `todo-ui` — by alias **or** relative path | B0 · *imports nothing from todo-app or todo-ui* |
| `todo-core` and `todo-app` touch no DOM global | B0 · *touches no DOM global* |
| `todo-app` imports no `todo-ui` | B0 · *imports nothing from todo-ui* |
| `todo-ui` reaches `todo-app` **only** through `@todo/app/models` — never a controller, `bootstrap` or the token | B0 · *reaches todo-app only through @todo/app/models* |
| `@todo/app/models` exports no controller, no `bootstrap`, no token — checked at run time, not by grep | B0 · *keeps @todo/app/models free of controllers…* |
| `todo-ui` never imports `todo-core` | B0 · *never imports todo-core* |
| only `view-adapter.ts` names the bus (`Commands`, `CommandsRegistry`) | B0 · *touches the bus only in the adapter* |
| a suite importing `@todo/ui` may not import `@todo/core` | B0 · *holds for todo-ui SUITES too* |
| `view-adapter.ts` imports no React | B0 · *view-adapter.ts imports the bus and the registry — no React* |
| a **node** suite takes `@todo/ui` only as `@todo/ui/adapter`, so headless stays headless | B0 · *a node suite… takes @todo/ui only as @todo/ui/adapter* |
| only `src/app.ts` imports all three layers | B0 · *only src/app.ts imports todo-core, todo-app and todo-ui together* |

### Models and events

| Rule | Enforced by |
| --- | --- |
| only a `*-model.ts` file calls `notify()` | B0 · *calls notify() only from a model* |
| nothing outside a model assigns a model field — outer model **or** input | B0 · *never assigns a model field* (see the limit below) |
| nothing outside a model or `use-model.ts` subscribes to bare `onUpdate` | B0 · *never calls onUpdate outside a model or the React binding* |
| a mutator compares before it writes | tests per mutator in `B1-models`, counting **raw** notifies |
| arrays and objects are replaced, never mutated | `expectReplacedNotMutated` in `B1-models` |
| a model's `onUpdate` covers every derived getter | `B1-models` · *an input query change fires the outer model's onUpdate* |

**The limit, stated honestly:** the field-assignment grep catches `model.input.x = …` and
`this._model.x = …`. It does **not** catch an aliased write — `const i = model.input; i.x = …`. For
views, the browser suites close the gap: every gesture test stubs the mutator to do nothing and then
asserts the model's `toJSON()` is unchanged, so a view that writes a field itself fails. For
controllers, there is no static guard. Do not alias a model to write through it.

### Wiring and lifetimes

| Rule | Enforced by |
| --- | --- |
| every registration is owned by `newRegistry` — no hand-rolled `offs` arrays | B0 · *uses newRegistry rather than a hand-rolled disposer array* |
| a controller cannot be activated before views are registered | `ViewsReady` token + B0 · *mints only in views-ready.ts and bootstrap.ts* and *holds the ViewsReady CLASS only in…* |
| `TodoApi` and its adapters name no command, model or bus | B0 · *keeps TodoApi and its adapters free of commands, models and the bus* |
| `dispose()` writes nothing after it resolves, and never deadlocks | `B3-controller/tests/dispose-liveness.test.ts` |
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
2. Add the field and its mutator to `TodoListInput`, with a comment naming its class.
3. Add a named channel: `onXChange = onChangeNotifier(this.onUpdate, () => this.x)`.
4. If an outer-model getter derives from it, forward the relevant channel to the outer `notify()`
   (see §3 of ARCHITECTURE.md), or a view bound to that getter goes stale.
5. Test in `B1-models`, counting **raw** `onUpdate` calls — never through the channel, whose own
   dedup would hide a missing compare-before-write guard.

### Handle an intent in the controller

1. Subscribe to its **channel** in `activate()`, through the registry: `register(model.input.onX(() => this._start()))`.
2. Drain or read it inside `_reconcile()` — the existing loop, not a second one. That is what keeps
   coalescing and re-entrancy correct.
3. Catch every failure where it happens and fold it into the run's `failure`; never let a rejection
   escape. Move a watermark only when the work landed — or, for an intent that asked the user a
   question, when the user answered.
4. After every `await`, check `_disposed` before writing the model.
5. Test in `B3-controller`: the class's obligation (coalesced? all honoured?), the failure path
   reported through `lastOutcome`, and no "Unhandled" anywhere in the output.

### Add a view

1. Declare its command in `lib/todo-app/src/ui-declarations.ts` (never in `todo-core`, which may not
   name `ui:`), with the view's model as input and the view's result as output. Export it from
   `models.ts`.
2. Write the component in `lib/todo-ui/src/views/`. Import from `@todo/app/models` and nothing else
   in `todo-app`. Take `{ model, settle }`. Bind with `useModel` — and pass `shallowEqual` for any
   selector returning an array or object. Turn every gesture into a mutator call; settle from the
   explicit gesture handlers (not from a derived "the dialog closed" event, which fires twice).
3. Register it in `register-views.tsx` with `show(adapter, mount, decl, render)`.
4. Test it in `B5-views` (browser): it renders from its model; each gesture calls the right mutator —
   with the mutator **stubbed to do nothing** and the model's `toJSON()` asserted unchanged; settling
   removes it from the DOM, checked where it actually lives (Radix dialogs render into
   `document.body`, not into your mount).

### Add a controller

Give it a constructor taking its model, the bus and the api; an `activate(ready: ViewsReady)` that
checks the token and subscribes to channels through a `newRegistry`; and an `async dispose()` that
sets `_disposed` first and runs the registry's cleanup **without awaiting in-flight work**. Expose
its creation as a capability from `bootstrap` returning `{ controller, release }` — do not export a
way to construct and activate it without the token.

## Commands you will use

```sh
pnpm test            # node suites
pnpm test:browser    # Chromium suites
pnpm test:B0         # just the boundaries — run it often
pnpm test:B3         # one rung
pnpm typecheck       # before every commit
pnpm dev             # the app (see README if it hits the file-watcher limit)
pnpm build && pnpm preview
```

To see console output from **passing** tests — warnings you want to audit — run vitest with
`--reporter=default`; the default reporter here hides it.

## Dependencies

- `vitest` is pinned to **v5** in this app, not the workspace catalog's v4, because
  `@vitest/browser-playwright` requires it.
- `@statewalker/ui.view.shadcn` is published; import its `./styles`, never a path into its source.
- If `pnpm add` rewrites `pnpm-workspace.yaml` — reordering it, stripping its comments — revert that
  file. It has happened more than once in this repository, and it destroyed a documenting comment.
