# Testing

How this app is tested, and the one lesson it kept relearning: **a test you have never watched
fail proves nothing.** While it was being built, well over a dozen tests passed every review, read
as correct, and could not fail. The catalogue below is the most reusable thing in this document.

## Principles

1. **Red before green.** Write the test, run it, and see it fail for the reason you expect — *then*
   write the code. A test that was green before the code existed is testing something else.
2. **Prove the test can fail.** After green, break the code on purpose — delete the guard, drop the
   subscription, invert the condition — and confirm the test goes red. Then restore it. Every fix in
   this codebase's history was accepted only with that evidence. This is cheap, manual mutation
   testing, and it is the single practice that found the most defects here.
3. **Assert the thing, not a proxy for it.** If the property is "the mutator did not notify",
   count notifies — not a derived value that some other mechanism also keeps stable.
4. **Headless first.** Node for everything that can be proven without a browser: models, commands,
   controllers, and the view *protocol*. Real Chromium only for what needs one.
5. **One rung, one property.** Each `B*/` directory proves one thing about the design. When a rung's
   suite fails, it names which part of the architecture broke.

## Layout: the ladder

```
B0-boundaries     the layering, as a fact about the files                  node
B1-models         models, mutators, channels, the three input classes      node
B2-commands       the command surface, defaults, override, `claimed`       node
B3-controller     reconciliation, coalescing, failure, disposal            node
B4-view-protocol  the adapter, bootstrap order, the panel lifecycle        node
B5-views          the React views and useModel                             Chromium
B6-app            the running app end to end; the kit's CSS is emitted     Chromium + node
```

```sh
pnpm test            # every node suite
pnpm test:browser    # every Chromium suite
pnpm test:B3         # one rung
```

The browser project is `vitest.browser.config.ts`: `@vitest/browser-playwright`, headless Chromium,
`--no-sandbox`. It requires vitest 5, which is why this app pins it.

## The tools

### The model kit — `lib/todo-app/src/model-kit.ts`

Assertion helpers that hold models and controllers to the design's rules. Each takes **mutators**,
never a field path — a helper that pokes `input[field] = …` would teach the opposite of the rule it
enforces.

| Helper | Asserts | Fails for |
| --- | --- | --- |
| `expectNoSelfWake({ reactions, writeOuter, writeInput })` | a controller is woken by an **input** write and **not** by an outer write | a controller subscribed to the outer model (it would loop) — **and** one subscribed to nothing |
| `expectCoalescedEdge({ bump, read, actions })` | a state-latest edge collapses repeated bumps | a controller that acts per bump, one that never acts, and a "mutator" that does not raise the counter |
| `expectReplacedNotMutated(model, read, mutate)` | the field was replaced **and** the replacement was observed through the notify channel | an in-place `push`, and a replacement that forgot to notify |

### `MemTodoApi` — `lib/todo-core/src/mem-todo-api.ts`

The reference adapter every headless suite runs against. Two properties make it a good test double:

- **Every method awaits a microtask** before returning. A controller that assumes it can read and
  write in one tick fails here, in Node, instead of in the browser.
- **`calls: string[]`** records every method invoked. Use it to witness that a handler ran — the
  store's contents often look identical whether it ran or not.

### `test-support/`

- **`views.ts`** — view-layer stand-ins suites boot with. Since the list controller shows its own
  panel on `activate()`, any suite that activates one must register a `ui:show-list` renderer — the
  honest precondition of any real app. `answerDialogs` answers `ui:show-dialog:confirm` and records
  `ui:notify` so controller suites can drive the clear-completed chain without React.
- **`api.ts`** — `seededApi()`: the real `MemTodoApi` holding one todo, for the protocol suites. They
  used to hand-roll a look-alike, because a B0 rule meant for view suites bound them too.
- **`react.ts`** — DOM plumbing for the browser suites: `render`, `waitFor`, `flush`, `button`. Use
  these rather than a local copy.

### The node project cannot load React

`vitest.config.ts` refuses to resolve `react`, `react-dom` and `@statewalker/ui.view.shadcn`. A node
suite that reaches them — directly, or by importing `src/app.ts` — fails at import with a message
naming the rule. Take the view layer as `@todo/ui/adapter`, or write a `.test.tsx` browser suite.

## Tests that could not fail

Every entry is real — found in this codebase by a reviewer who broke the code and watched the test
stay green. They are grouped by the *shape* of the mistake, because the shapes recur.

### 1. The test asserts a proxy, not the thing

The most common shape by far.

- **"Raises no notify when handed the value it already holds"** subscribed through a named channel.
  `onChangeNotifier` already skips unchanged values, so deleting the mutator's compare-before-write
  guard left the test green — it proved the channel's dedup, not the mutator's. **Found three
  times**, on three different mutators. Fix: count **raw** `onUpdate` calls. And a fourth time
  with no test at all: `setShowDone`'s only coverage went through the outer model, which hears it
  via `onQueryChange` — a channel, with its own dedup — so deleting its guard left every suite green.
- **A snapshot cannot see a write that stores equal data.** Each gesture test asserts the model's
  `toJSON()` is unchanged after the stubbed mutator. A view that also called
  `model.replaceTodos(model.todos)` — a controller-side write, and a notify — changed nothing a
  snapshot compares, and passed all forty browser tests. Fix: a static rule on *who may call which
  method* (B0), because no snapshot can tell equal data from untouched data.
- **"Still runs the default when nothing overrides"** toggled a missing id and asserted the store was
  empty — true whether the default handler ran, threw, or was never registered. Fix: witness it on
  `MemTodoApi.calls`.
- **"Two quick presses open one dialog"** would have passed checking only the final list. Fix: count
  the `ui:show-dialog:confirm` calls.

### 2. Nothing to catch

The input could not produce the failure the test is named for.

- **The recursion guard** asserted `sources("todo-ui").length > 0`. `index.ts` is top-level, so a
  non-recursive directory walk still returns one file. The one test whose job was to notice the
  recursion breaking could not notice it. Fix: assert the **nested** file by its path.
- **"Never offers the `ui:*` vocabulary"** — the menu's catalog contained no `ui:` key at all, so no
  filter bug could put one in the menu. Fix: have a host override return a `ui:` key, and assert it
  is **not** offered.
- **"A healthy app logs nothing — including across dispose"** was the only test near the
  composition root's `disposed` guard. A healthy app never has a failed panel, so the guard had
  nothing to suppress, and deleting it left the test green. Fix: create the condition — a broken
  view layer, disposed in the same turn, while its failure is still pending.
- **A stated failure path with no test.** `bootstrap`'s unwind was described as a saga; nothing ever
  made `registerViews` throw, and when it did, the command defaults stayed on the bus. Fix: make the
  step fail, then call the command it should have released.

### 2b. A release nobody counts

- **`useModel`'s unsubscribe.** A version that never unsubscribed passed every browser test: a
  leaked listener re-renders nothing that is still on screen. Fix: count live subscriptions at the
  source (wrap `model.onUpdate`) and assert they return to zero on unmount.

### 3. One change masks another

- **Dropping the "Show completed" subscription** left all eleven list-view tests green, because the
  only test that changed show-completed also changed the filter in the same tick, and the filter's
  subscription re-rendered for both. In the running app the checkbox silently stopped filtering.
  Fix: a test that changes **only** show-completed, alone, in its own tick.
- **A single model change can land before React subscribes**, and React re-renders for it anyway —
  so a view with a **missing** subscription still shows the right value once. Fix: change each field
  **twice**; the second change is the one a missing subscription cannot follow.

### 4. The timing proves nothing

- **The toast's "not before its timeout"** check ran `flush()` straight after render — before the
  effect that starts the timer had even committed — so a toast that settled instantly passed. Fix:
  wait for the toast, then check halfway through its window.
- **The toast-timeout option** was never proven to reach the toast: its default was shorter than the
  test's own timeout, so dropping the option still passed. Fix: race the settle against a bound
  shorter than the default.
- **Coalescing measured synchronously** sees only the first reload. The deferred follow-up happens a
  microtask later. Fix: bump five times, **await**, and assert the settled total — two, not five.
- **A precondition raced its own subject.** The unsubscribe test checked "subscribed" as soon as the
  component's layout effect had run — but `useSyncExternalStore` subscribes in a *passive* effect,
  later. It passed by luck of scheduling until a plant in a neighbouring test changed the timing.
  Fix: wait for the subscription itself.

### 5. The spy calls through

- **"A gesture reaches the model only through a mutator"** used spies that called the real mutator.
  A view that wrote the field itself *and* called the mutator passed. Fix: stub the mutator to do
  nothing (`mockImplementation(() => {})`), then assert the model's `toJSON()` is unchanged.

### 6. The grep is too narrow

- **The mutation rule only grepped `.input.`**, so a controller assigning `this._model.todos = …`
  bypassed the mutator, raised no notify, and left every view showing an empty list — with 73 of 73
  tests green. Fix: also match assignments to the outer model.
- **The port-purity grep used `\b(Model)\b`**, which does not match `TodoListModel`. Importing
  `CommandDeclaration` into the port passed. Fix: match the substring.
- **Every layering grep matched `@todo/app` aliases only.** A relative import —
  `"../../todo-app/src/todo-model.js"` — walked past all of them. Fix: normalise both forms.
- **The grep reads names; the runtime loads modules.** "A node suite takes `@todo/ui` only as
  `@todo/ui/adapter`" checked what a suite *names*. A node suite importing `../../src/app.js` named
  no `@todo/ui` and loaded React, react-dom and every view — green. Fix: refuse the React stack at
  resolution in the node project, and prove the refusal is on with a live import in B0.

### 6b. The exemption is too wide

The mirror image of a narrow grep: the rule is right, and the list of files it skips is not.

- **`endsWith("-model.ts")`** was meant to exempt model modules from "only models notify / write
  fields / subscribe to bare `onUpdate`". It also matched `use-model.ts` — the React binding — and
  would have matched any `todo-ui/src/views/selection-model.ts`. Fix: exempt by **location**
  (`todo-app/src/`), and assert the exact list of exempt files, so a widened exemption fails.
- **`endsWith("view-adapter.ts")`** exempted any file with that suffix from "only the adapter names
  the bus". Fix: the exact path.

### 7. The helper ignores its argument

Inherited from the sibling app this blueprint descends from:

- **`expectNoSelfWake(input, outer, …)`** began with `void input;`. It asserted only that an outer
  write did not wake the controller — which is also true of a controller subscribed to nothing. Fix:
  assert both directions.
- **`expectEdgeCounter`** computed `(value + 2) - value >= 2`. It is arithmetic; it cannot fail for
  any numeric field.
- **`expectReplacedNotMutated(model, …)`** accepted `model` and never read it, comparing identity
  only — so a replacement that forgot to notify passed. Fix: watch the model.

### What to take from this

When you write a test, ask **"what change to the code would leave this green?"** If the honest
answer is "the bug I'm testing for", the test is not testing it. Then break the code and find out.

And plant the **regression the test exists for**, not a nearby change. Checking the dispose-liveness
suite, a first plant moved the host's `todos:add` override below the core's default — and stayed
green, because every listener runs whatever its priority, so the dialog opened anyway. That proved
nothing about the test. The regression it guards is a `dispose()` that waits for in-flight work;
planting that failed both tests at once.

## Specific traps

- **Radix renders dialogs into `document.body`**, not into your mount element. Assert removal where
  the dialog actually lives.
- **The default vitest reporter hides console output from passing tests.** To audit React `act()`
  warnings or unhandled rejections, run with `--reporter=default` and grep for them.
- **Tailwind scans test files too.** A test that names a CSS class to assert it is emitted will cause
  Tailwind to emit it. `emitted-css.test.ts` builds the class name from pieces for this reason.
- **Watch for unhandled rejections.** Controller work is fired with `void`; a rejection that escapes
  it reaches the process, not the user. Suites that exercise failure paths collect
  `unhandledRejection` events and assert none arrived.
- **Headless suites must not load React.** Import the adapter as `@todo/ui/adapter`. B0 checks the
  names, and the node project refuses to resolve React, react-dom and the kit at all — because the
  day a view touches `document` at module scope, every node suite loading a view would break at
  import for reasons unrelated to what it tests.
- **A literal dynamic `import("react")` is resolved when the file is transformed**, not when the line
  runs. To assert that an import is refused, import through a variable
  (`import(/* @vite-ignore */ spec)`), or the refusal fails the whole file instead of one assertion.
- **Focus after a Radix dialog moves on a timer.** Radix restores focus in a `setTimeout` after
  unmount; wait a few turns before asserting where focus is.
