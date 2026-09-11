# Testing

How this app is tested, and the one lesson it kept relearning: **a test you have never watched
fail proves nothing.** While it was being built, roughly a dozen tests passed every review, read
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

Shared view-layer stand-ins suites boot with. Since the list controller shows its own panel on
`activate()`, any suite that activates one must register a `ui:show-list` renderer — the honest
precondition of any real app. `answerDialogs` answers `ui:show-dialog:confirm` and records
`ui:notify` so controller suites can drive the clear-completed chain without React.

## Tests that could not fail

Every entry is real — found in this codebase by a reviewer who broke the code and watched the test
stay green. They are grouped by the *shape* of the mistake, because the shapes recur.

### 1. The test asserts a proxy, not the thing

The most common shape by far.

- **"Raises no notify when handed the value it already holds"** subscribed through a named channel.
  `onChangeNotifier` already skips unchanged values, so deleting the mutator's compare-before-write
  guard left the test green — it proved the channel's dedup, not the mutator's. **Found three
  times**, on three different mutators. Fix: count **raw** `onUpdate` calls.
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
- **Headless suites must not load React.** Import the adapter as `@todo/ui/adapter`. B0 enforces it,
  because the day a view touches `document` at module scope, every suite importing `@todo/ui` would
  break at import for reasons unrelated to what it tests.
