# P2: lessons

Prototype **P2** (`apps/mvc-blueprint-10`) rewrites the internals of P0's controllers as state
machines. It uses `@statewalker/fsm` 0.38.1 (from npm) for `todos.edit`, `contacts.edit` and
`todos.clear-completed`, and XState 5.33.2 for a second `contacts.edit`. **Status: DONE.**

- P0's 150 node tests and 24 Chromium tests pass unchanged on both editions of `contacts.edit`.
- 27 new node tests cover the charts, the kit, the XState machine, the library characterisation
  and dispose mid-commit.
- Typecheck, biome and `vite build` are clean.

## Headline

**The machines remove the plumbing completely but not the code.** Each P0 controller had 32–35
lines of plumbing: `active`, the `Session` record, the update loop, `pass()`, `close()`,
`??=` folds, `askOwed` and `cancelled`. In the machine versions that count is **0**. They are
replaced by a 21–28 LOC chart per controller and one shared 113 LOC kit, so controller LOC stays
flat (−3 to +6).

- What changes is the kind of code. Lifecycle becomes a declared table, and resources are
  scoped to states. The state that published the editor panel withdraws it when it exits.
- A continuation cannot run after its state has gone, so still-active checks disappear. This is
  structural, as R2's "turns dropped once stopped" is.
- `@statewalker/fsm` **as published is not safe to use directly** for UI controllers (four
  hazards, below). A ~110 LOC wrapper made it good.
- XState works out of the box but is 9× bigger. It also forces a parent↔child message protocol
  for model writes, because `stop()` skips exit actions.

## History

| Commit | What |
| --- | --- |
| `52668de` | copy of P0 + `@statewalker/fsm` 0.38.1, `xstate` 5.33.2 (exact) |
| `5787d1d` | `@kit/machine`; `todos.edit` as a chart; library characterisation, chart tests |
| `0a20e82` | `contacts.edit`, `todos.clear-completed` as charts; a state's sends die with it |
| `d193c4a` | `contacts.edit.xstate`; XState machine test; dispose mid-commit tests |
| (last) | README, LESSONS, static edition switch |

## Per controller

LOC counts non-blank, non-comment lines (`scripts/loc.mjs`). The controller is `index.ts` plus
`machine.ts`. The form/confirm models are unchanged and not counted. Plumbing lines are lines
that mention `active`, the session, the loop, `pass`, `close(`, `??=`, `askOwed` or `cancelled`.

| Controller | LOC P0 → P2 | Plumbing lines P0 → P2 | States (excluding root) | Transitions (+ initial) | Unit test without DOM |
| --- | --- | --- | --- | --- | --- |
| `todos.edit` | 153 → **159** (131 + chart 28) | 35 → **0** | 4: `closed`, `open{editing, saving}` | 6 (+2) | `tests/machines/todos-edit.machine.test.ts`: 6 tests |
| `contacts.edit` (fsm) | 122 → **119** (97 + chart 22) | 32 → **0** | 4 | 5 (+2) | `contacts-edit.machine.test.ts`: 3 |
| `todos.clear-completed` | 146 → **145** (124 + chart 21) | 33 → **0** | 4: `idle`, `busy{asking, clearing}` | 4 (+2) | `clear-completed.machine.test.ts`: 3 |
| `contacts.edit` (XState) | 122 → **159** (95 + machine 64) | 32 → **0** | 4 | 5 (+2) | `contacts-edit.xstate.test.ts`: 3 |
| kit | `@kit/loop` 77 (still used by other bundles) | — | — | — | `kit.test.ts`: 5; `@kit/machine` is 113 LOC |

The chart tests run the real chart with recording handlers (`tests/machines/trace.ts`). They
assert paths and enter/exit order: refuse while saving, two same-tick saves become one transition,
a replacing `edit` exits `saving` then `open`, and `stop` unwinds inner-first.

## `@statewalker/fsm` vs XState on `contacts.edit`

| | `@statewalker/fsm` 0.38.1 (+ `@kit/machine`) | XState 5.33.2 |
| --- | --- | --- |
| Controller LOC (index + chart) | 97 + 22 = **119** | 95 + 64 = **159** |
| Shared code needed | the kit, 113 LOC (once for all controllers) | none |
| Dependencies added | 1, zero transitive | 1, zero transitive |
| Library, minified / gzip (the API used, esbuild) | **4.4 KB / 1.5 KB**; kit +1.2 KB / 0.7 KB | **40.6 KB / 13.2 KB** |
| Controller bundle, minified / gzip (library + kit + controller; kernel and other kits external) | 7.3 KB / 2.9 KB | 43.1 KB / 14.3 KB (P0: 1.9 KB / 1.0 KB) |
| Typing | untyped strings; event data is `unknown`, cast in the handler (2 casts) | typed events and context; the entry/input `event` is the union, so 3 `Extract<>` casts |
| Where the model is written | state handlers and task continuations, as plain closures | a `fromCallback` **session actor** that owns the model and panel; the machine writes via `sendTo("session", {type: "running"})`, and the session also handles `failed` |
| Disposal | `machine.stop()` exits every state inner-first, so exits release resources | `actor.stop()` **does not run exit actions**. Resources must be invoked actors, which are stopped. This forced the session-actor design. |
| Commit time | the submit listener sends `("save", draft)`; data travels with the event | the same (`{type: "save", draft}`) |
| Refuse while running | no rule for `save` in `saving`, so it is dropped when processed | no handler, so it is ignored |
| Writes inside a notification | never (handlers run in a microtask) | `send` is synchronous: entry actions run inside the caller. The session defers `sendBack` with `queueMicrotask` to keep writes out of the submit notification. |
| Unit testing | a chart plus recording handlers | `machine.provide({actors, actions})` with stubs: the most direct test of all |
| Gotchas hit | 4 library hazards (below) | a `.` in the machine `id` breaks `#id.state` targets; the stopped-actor send warning goes to `console` |

## What worked

- **Resources scoped to states.** The panel, the form model and the submit listeners are created
  in `open`'s handler and released by its exit. "Close", "replace" and "dispose" become one code
  path: leave the state. A replacing `edit` exits `saving` and then `open`, and enters a fresh
  `open`. That is the whole of P0's `close(session)` / `session === s` logic.
- **Still-active checks are gone.** A task continuation runs only if its state is still active. A
  state's `send`s die with it, even when they are already queued. After `stop()` everything is
  dropped. The P0 dispose test ("nothing is written after an await that resolves late") passes on
  both editions. The kit's own tests fail when the check is removed (a verified negative control).
- **Refuse has a natural home:** an event with no rule in the current state. The same-tick double
  Save needed `commit ??= snapshot` in P0 and needs nothing now. The second event is processed in
  `saving`, has no rule, and is dropped, and its draft goes with it. The same holds for Clear
  completed's second ask.
- **Commit time survives unchanged.** The snapshot is still taken synchronously in the submit
  listener; it simply travels as the event's data.
- **Charts are testable in isolation**, with no DOM, no kernel and no models: 12 chart tests plus
  3 XState tests.
- **Answer-once semantics come from scoping listeners to a state.** The dialog's confirm/cancel
  listeners live in `asking`, so a cancel during `clearing` never reaches the machine. A confirm
  and a cancel in the same tick resolve to "first answer wins". This is tested, and the test fails
  without the kit's liveness check.
- **P0's refusals map one-to-one onto chart rules.** The "asked while the dialog is open" and
  "saved while saving" guards were rules all along.

## What failed or bit

1. **`@statewalker/fsm`'s runner (`startProcess`) checks the guard when an event is dispatched,
   not when it is processed.** A second same-tick `save` passes the guard (the state is still
   `editing`), is queued, is processed in `saving` with no rule, falls back to the final state and
   **unwinds `saving` and the root: the machine ends.** This is pinned in
   `tests/machines/fsm-library.test.ts`. Every double-click would have killed the editor.
2. **An unmatched event leaves the state** (`getTargetStateKey` falls back to `STATE_FINAL`). This
   is by design ("an unmatched event exits the state rather than silently doing nothing"). It is
   the opposite of what UI controllers need, where unmatched means refused.
3. **A generator handler's code after an `await` still runs after `shutdown()`.** `return()` on an
   async generator waits for the next `yield`. The runner's generator mechanism for async work
   therefore reintroduces "check you are still active". This is pinned by a test.
4. **Errors go to `console.error`**, and the machine stays in the state whose handler threw. The
   kit replaces the engine's `_handleError` (a private override) to log through the bundle's
   logger.
5. **There are no event payloads** (events are strings), and state handlers are looked up by one
   global `load(stateKey)`. Children cannot close over their parent's locals without a side
   channel. The kit adds `send(event, data)` and `{exit, states}`.
6. **No cross-level targets and no "ignore" rule.** A rule inside `open` can only target `open`'s
   children. "Cancel only while editing" cannot be written as a rule, because the parent's
   `cancel → closed` applies to every child. It was expressed by scoping the listener instead
   (clear-completed), or accepted (editors: see 8).
7. **The exit-resets-presentation idiom broke a P0 test.** Writing `running: false` in `saving`'s
   exit also writes it during `stop()`, and P0's dispose test pins "the disposed model kept its
   last value". Fix: presentation is set on *enter* of the state it describes (`editing` sets
   `running: false`). Lesson: in a machine, write presentation on enter, release resources on
   exit.
8. **Semantic divergence, made visible by the machine.** In P0 a `cancel` or a replacing `edit`
   during a save let the save finish and still notified "Saved" or "Save failed" ("say so even if
   this session was replaced"). In the charts, leaving `saving` drops the result. The write still
   lands in the store and a failure is still logged at `warn`, but no notification appears. No
   test pinned P0's behaviour. Keeping it would need either the task owned by the root state
   (and a session id to ignore stale results) or a `cancelling` state that waits.
9. **XState: `actor.stop()` does not run exit actions** (verified). The obvious design (create the
   session in `entry`, release it in `exit`) leaks the panel on dispose. The working design makes
   the session an invoked `fromCallback` actor. Model writes then become messages (`SessionEvent`)
   from the machine to the session: a protocol that P0 and the fsm edition do not need.
10. **XState's synchronous `send`** runs entry actions inside the submit listener, which would
    write the action model inside its own notification (MODELS.md §4 point 5). Deferring
    `sendBack` fixes it but must be remembered.
11. **The edition switch** (`import.meta.env.VITE_CONTACTS_EDIT`) is not tree-shaken: the other
    edition's module-level `setup().createMachine()` call keeps it alive. Both builds carry both
    libraries. Sizes above were therefore measured with esbuild on isolated entries.

## Pros

- The lifecycle is declared, so it can be read as a table: 21–28 lines per controller list every
  state and every legal event. Refuse-while-running reads as "no rule".
- Resource ownership follows states, so disposal, replacement and closing share one mechanism.
- No still-active checks, no update loop, no `??=`, no owed flags: the class of bug they guard
  against is gone structurally, not by discipline.
- Charts can be unit-tested with no DOM, no kernel and no models.
- `@statewalker/fsm` is tiny (1.5 KB gz) with zero dependencies, and its hierarchy (bubbling to
  the parent) fits "`cancel` from anywhere in `open`" exactly.
- The activator signature is untouched: `startMachine` inside, `register(() => machine.stop())`
  as the cleanup.

## Cons

- **No LOC saving.** The plumbing is replaced one-for-one by the chart plus handlers. The kit
  (113 LOC) is new shared code a newcomer must learn.
- **Three new concepts:** chart (states, nested states, rules, wildcards), state handler (enter
  returns exit or children), and task (a continuation scoped to a state). One P0 rule is removed
  ("after every `await`, check you are still active").
- Event data is untyped (`unknown` plus a cast) with `@statewalker/fsm`. The chart and handlers
  are matched by string keys, so a misspelt state name makes its handler silently not run.
- **Two places to read.** The chart says *when* and the handlers say *what*. In P0 both lived in
  `pass()`.
- The machines surfaced semantic questions that P0's code answered implicitly (lesson 8). This is
  a pro for design, but it costs a decision per controller.
- `@statewalker/fsm` needs the wrapper. Its runner's defaults (call-time guard, unmatched means
  exit, generators after shutdown) are wrong for UI controllers.
- XState: 13 KB gz, more concepts (setup, actors, invoke, `sendTo`, `assign`, `provide`, context),
  and the stop-without-exit rule pushes model ownership into child actors.

## Fitness table

Only the controllers changed, so every row except Simplicity and Separation is **unchanged from
P0**, as the evidence column shows.

| Axis | Measurement | Value | Notes |
| --- | --- | --- | --- |
| Simplicity | concepts and rules a newcomer must learn | **28** (P0: 26) | +3: chart, state handler (`enter → exit / children`), task; −1: the still-active rule. Refuse-or-queue (25) now has a mechanism for refuse. XState edition: +6 instead of +3 (setup/createMachine, invoke, fromPromise/fromCallback, provide, sendTo, assign/context). |
| Simplicity | LOC / files of the minimal no-kit bundle (`hello`) | **80 LOC / 2 files** (unchanged) | `hello` is untouched; it has no async lifecycle to model |
| Simplicity | Rename a todo: files touched, lines +/− | **unchanged from P0** (11 files, +291/−11) | `todos.rename` is not rewritten; as a machine it would be `todos.edit`'s chart (one more `open` state) |
| Simplicity | controller plumbing lines (P2 measure) | **35 / 32 / 33 → 0 / 0 / 0** | LOC 153 / 122 / 146 → 159 / 119 / 145 (+ kit 113, shared) |
| Separation | boundary suite: rules / violations | **8 rules / 0 violations** | kits and bundles are policed as in P0; the new bundle and kit are included |
| Separation | single-writer violations | **0** | the type-level and runtime single-writer tests pass unchanged; the machine writes only control facets |
| Separation | domain-logic hits in views | **2** (unchanged) | renderers are untouched |
| Independence | cross-bundle edges / to API modules / violations | **53 import sites (35 distinct) / 53 / 0** without the XState edition; **60 (39) / 60 / 0** with it | `@kit/loop` → `@kit/machine` in three bundles |
| Independence | standalone runs (Todos, Contacts) | **pass / pass** | P0's standalone suites, node and Chromium |
| Independence | removal runs: errors / coverage | **4 runs, 0 error logs** (unchanged) | P0's removal suite |
| Composability | interactions (1)–(3) pass | **3/3** | P0's e2e under React, DOM and headless |
| Composability | files changed in Contacts for interaction (1) | **0** (unchanged) | |
| Composability | second UI technology: logic files changed / new UI LOC | **0 / 0** | both hosts and all renderers run the rewritten controllers unchanged (24 Chromium tests, both editions) |
| Correctness gate | contract · commit races · dispose · late subscriber · read-then-set | **green** | P0's contract 83 + single writer 4, commits 9, dispose 4 (+2 mid-commit P2), late 3, read-then-set 7 + loader 7, on **both** editions of `contacts.edit` |

Totals: node **177** tests (150 P0 + 27 P2), Chromium **24**, on both editions. LOC (non-test):
kits 686 (P0 573, +113 `@kit/machine`), logic 2006 (P0 1758: +246 for the XState edition's bundle,
including its copied 87-LOC model, and +2 net for the three rewrites); tests 2878 (P0 2348).

## Answers to the points to clarify

- **Did the machine replace the in-flight guard and the "still active after await" checks, or add
  to them?** It **replaced** them. The in-flight guard is the absence of a rule for `save` in
  `saving`, checked at processing time, so the same-tick fold (`??=`) went too. The still-active
  checks became the kit's per-state liveness: continuations and sends of an exited state are
  dropped. The one condition is that the kit must check when the event is *processed*.
  `@statewalker/fsm`'s runner checks at dispatch time, which would have added a bug instead
  (lesson 1). Caveat: P0's models already ignore writes after `dispose()`, so in these three
  controllers P0's `if (!active)` checks guarded little that was observable. The machine makes the
  guarantee structural rather than a property of each model.
- **Where does model writing happen?** Inside the machine: in state handlers (on **enter** for
  presentation such as `running`; exits only release resources) and in task continuations (form
  errors, notifications). With XState it happens in a child `session` actor that receives
  `running` / `failed` messages, because the machine cannot own a resource that must be released
  on `stop()`.
- **Would a newcomer read the machine or the closure version faster?** **Not measured.** The spike
  contract forbids dispatching subagents, so no fresh agent was asked. This is left to the
  controller (see the reply). Proxy measures: to see when Save is refused, a reader of P0 must
  follow `onSubmits → ??= → loop.kick → pass → running`. A reader of P2 looks at one chart line
  (`["editing", "save", "saving"]`, and no `save` rule in `saving`). But P2 adds a second file
  and a kit contract (enter/exit/`task`) that must be learnt first.
- **Is `@statewalker/fsm` missing anything the benchmark needed?** Yes. The kit supplies all of
  these:
  1. a guard checked when an event is processed, with no exit on unmatched events (or an explicit
     "ignore");
  2. event payloads;
  3. handlers scoped to the parent state's closure;
  4. async work whose continuation is dropped once its state exits (the generator mechanism
     leaks past shutdown);
  5. a pluggable error sink;
  6. typed events and states.

  Nice to have: cross-level targets, and transition actions.

## Recommendation for consolidation

- **Adopt "controller internal state as a chart" as an optional kit pattern,** not a kernel
  concept. Use it for controllers with a lifecycle: editors, dialogs, in-flight commits. It
  removes P0's biggest repeated cost (the snapshot/loop/`running`/still-active plumbing) and
  gives refuse-while-running a home. Keep the activator signature. Keep commit-time capture in the
  submit listener, with the capture carried as event data.
- **Use `@statewalker/fsm`, not XState,** through a small wrapper with `@kit/machine`'s
  guarantees:
  - processing-time guard, where unmatched means dropped;
  - event data;
  - nested handler scopes;
  - state-scoped tasks;
  - handlers run outside notifications;
  - errors to the logger.

  Better still, upstream them into `@statewalker/fsm`: the call-time guard (lesson 1) and the
  generator leak (lesson 3) are defects for any consumer.
- XState's typing and `provide`-based testing are better, but its size (9×), its concept count
  and stop-without-exit do not pay off for controllers this small.
- **Rules for authors:**
  - Presentation is written on enter.
  - Resources are released on exit.
  - Listeners that answer a question live in the state that asks it.
  - Decide explicitly what leaving an in-flight state does to its result (lesson 8). The
    definition should say whether a replaced session still reports its outcome.
- Leave queue-mode actions (Add) as P0 has them. A machine gives refuse a home, but a queue is
  data (a list of snapshots), not state.
