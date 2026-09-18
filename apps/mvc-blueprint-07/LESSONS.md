# R3 — event-sourced intents: lessons

Status: **done**. The benchmark is complete and green (node 97 tests / 14 files, Chromium 15 / 2),
Rename a todo landed in one commit, and the correctness gate passes. The verdict is mixed: the log
is a real improvement for **commits, failures, disposal and debugging**, and no improvement at all
for **state**. At local scope the log is not event sourcing; it is a command bus that keeps its
history and writes its own outcomes. That is the part worth keeping.

## 1. What was built

- **Kernel** (523 LOC): context with the read-then-set guard, loader, logger, slots (`shared-slots`),
  shared model types, and the **intent log** (`src/kernel/log.ts`, 340 LOC). No commands package.
- **The log**: `append(type, payload)` clones and freezes the payload and dispatches the record to
  every projection, then to the one handler of its type. The handler's return value, or its throw,
  becomes an **outcome record** that the log appends itself (`{ ok, value | error, cause }`). An append
  made during a dispatch is queued, so every subscriber sees every record in `seq` order before the
  outermost `append` returns. Each bundle holds a **scope** (`openLog(context, origin)`); `close()`
  unregisters its handlers and projections, writes an "abandoned" outcome for its in-flight intents,
  and makes further appends throw.
- **Kit** (272 LOC, optional): `cell`/`derived` (a listener set), `alienCell` (the second substrate,
  used only by the contract suite), `intentAction`, `followSlot`/`followList`, React `useModel` and
  `ActionButton`.
- **Bundles**: shell (API, notifications, React host + coverage), Todos (core, list, edit,
  clear-completed, status, rename, React renderers), Contacts (core, list, edit, React renderers),
  `todos.contacts-link`, `hello`, and the optional `sys.log-viewer`.

## 2. What worked

1. **A commit is a record, and nothing else has to be.** Every save carries its draft in the
   payload. The kernel captures it at append time (`structuredClone` + freeze, one line). No handler
   reads a form, so no handler has a snapshot mechanism. Commit-time tests: edit → submit → keep
   typing, for Todos, Contacts, Rename and the link, including a **multi-step commit** (async
   validation, then the mutation). All pass. *Where the committed value comes from:* the
   `todos.edit:save` record's `payload.title`, asserted in `tests/commits/todos-commits.test.ts`.
2. **Failures report themselves.** A handler throws, and the log writes the failed outcome. A form's
   error is a projection of the outcomes of its session's saves (about 6 lines per form). No
   `reportErrors` call exists anywhere. A failure is visible **in the log** as well as on the form.
3. **"Never silently lost" holds by construction.** Every appended intent gets an outcome, even when
   its handler's bundle stops (`abandoned: … stopped before answering`). `running` is not written by
   any reactor: it is derived as "this action's records have no outcome yet".
4. **Disposal is enforced by the kernel, not by discipline.** No handler has an "am I still active?"
   check after its awaits (0 in the codebase). A late continuation that tries to append throws, and
   its promise is ignored. The dispose test leaves an in-flight save, an open dialog, a toast timer
   and a pending add, then stops: slots are empty, handlers 0, projections 0, pending 0, no append
   after the late api resolution, and no model notifies. The bundles hold 5 `!log.closed` guards,
   all in view-intent closures, so that a stale view facet is a no-op and not a throw.
5. **The log gives multi-step handlers optimistic concurrency.** `since(seq)` lets a save that awaited
   validation ask "did anything remove this todo meanwhile?". The race test (Delete lands during
   validation) fails the save visibly, and nothing is resurrected. None of the other shapes gives
   this for free.
6. **Debugging.** The log viewer is 92 LOC including its renderer (`?app=debug`). It shows every
   gesture with its origin, payload, cause chain and outcome. It is the most concrete benefit of the
   whole shape.
7. **An unanswered link is loud.** Policy `required` plus a single handler: the link bundle with
   Todos absent logs `no handler for required intent todos:compose (from todos.contacts-link)` and
   records a failed outcome (`tests/independence`).

## 3. What failed, or did not deliver

1. **It is not event sourcing, and it cannot be at this scope.** Domain truth lives in the api
   services, not in the log. A projection is correct only from its activation, and a late consumer
   gets state from the owner's **retained slot**, not from replay. The ownership experiment
   (`tests/correctness/ownership.test.ts`) builds `todos:collection` a second time by replaying the
   log through the owner's fold. It matches while the log is kept whole, and it **silently diverges**
   once the log is compacted. "Anyone may build the projection" would require exporting the fold
   (implementation in an API module) *and* infinite retention. Rejected.
2. **Compaction is subtle, and the first version was wrong.** It pruned settled records newer than an
   in-flight handler's cause, so that handler's `since(seq)` check went blind. The fix is a watermark
   at the oldest pending intent. Its price: **a stuck intent pins the log** (test: 101 records
   retained with `retain = 10` while one intent is pending).
3. **`request()` is a command call by another name.** Handlers that chain (save → `todos:update` →
   close) await outcomes exactly as P0 awaits commands. The `cause` link is new; the control flow is
   not.
4. **Correlating an outcome with its form costs a map.** An outcome carries only `cause`. To find the
   form, each editor keeps a `seq → session` map in its projection (`todos.edit`, `contacts.edit`).
   That is boilerplate a kernel `recordOf(cause)` would remove.
5. **"Views append intents" held only as "views call model members that append".** A renderer that
   dispatched `(type, payload)` itself would assemble payloads, which is domain logic, in views. The
   facet stays the capability, so the renderer layer is identical to P0's. The "break" of action
   models is also partial: the view-facing `ActionView` is unchanged, because `shell:menu` needs it.
   What changed is behind it: submit appends instead of bumping an edge.
6. **Intent design is not answered by the log.** A toggle's payload is absolute
   (`{ done: !current }`, captured at commit time, per ADR-012). So 1000 rapid toggles before any
   outcome all carry the same value: one state change, not 1000 flips. That is correct, but it is a
   choice each intent must make: absolute or relative.

## 4. Pros

- Commit semantics, failure recording and in-flight state come out of one mechanism, with no
  per-controller code.
- The kernel enforces disposal and "no write after stop".
- Total order, a cause chain and a built-in audit trail: debugging and tests read the log.
  `recordsOf(app, "todos:compose")` is how the link test proves that the selection was read at commit.
- Handler uniqueness and the `required` policy make wiring mistakes loud.
- Bundles are small, and the dependency graph stays clean: every cross-bundle edge goes to an API
  module, and each bundle's fan-out is at most 2.

## 5. Cons

- One more kernel primitive, and the largest one: the log is 340 LOC with ordering, scopes, replay,
  compaction and a watermark, each with a subtle rule.
- Two ways to observe: slots for things that exist, the log for things that happen. Late subscribers
  use slots; the log's replay is only for tools.
- The log grows without bound unless the kernel is given `retain`, and a pending intent defeats
  `retain`.
- More records than commands: every answered intent writes 2 records.

## 6. Fitness table

| Axis | Measurement | Value | Notes |
| --- | --- | --- | --- |
| Simplicity | concepts and rules a newcomer must learn | 16 (hello uses 9) | README lists them; 5 are the log's (scope, intent, event, handler/outcome, projection) |
| Simplicity | LOC / files of the minimal no-kit bundle (`hello`) | 59 LOC / 2 files logic (+api); renderer 16 / 1; total 75 / 3 | kernel only, with a hand-rolled model; an event plus a fold |
| Simplicity | Rename a todo: files touched, lines +/− (logic / UI / tests) | 7 files, +201 / −1: logic 3 files +119/−0 · UI 2 files +28/−1 · tests 2 files +54/−0 | commit `1f8a2c3`; one new bundle, the API gains a view kind, one line in features |
| Separation | boundary suite: rules / violations | 6 rules / 0 violations | each rule has a negative control that fails as it should |
| Separation | single-writer violations | 0 | type-level over 13 view facets; runtime over every published model (frozen; only getters, subscriptions and view intents) |
| Separation | domain-logic hits in views | 0 counted (await, `.call(`, provide/register outside the contribution file, service imports) | render-only conditionals: `status.error &&`, pluralisation, `!contact → null`, ctrl/meta click for additive selection |
| Independence | cross-bundle edges / to API modules / violations | 41 / 41 / 0 | import statements; fan-out ≤ 2 API modules per bundle (`pnpm deps`) |
| Independence | standalone runs (Todos, Contacts) | pass / pass | node (headless, with renderers for coverage) and Chromium |
| Independence | removal runs: errors / coverage report | 4 runs (todos-contacts, todos.status, Contacts, Todos): 0 errors each; coverage empty | removing a UI bundle lists its panel in the coverage report (tested) |
| Composability | interactions (1)–(3) pass | 3 / 3 | node and Chromium e2e |
| Composability | files changed in Contacts for interaction (1) | 0 | `todos.contacts-link` imports `contacts/api` and `todos/api` only |
| Composability | second UI technology: logic files changed / new UI LOC | n/a | React only, per the brief; the boundary suite pins 0 UI imports in logic bundles |
| Correctness gate | contract · commit races · dispose · late subscriber · read-then-set | pass · pass · pass · pass · pass | contract: 3 implementations (listener cell, alien-signals cell, projection over the log); 17 commit-time and race tests (Todos 11, Contacts + link 4, Rename 2); 5 late-subscriber tests |

Log size: the §14 scenario (node) appends **53 records**: 25 intents, 3 events and 25 outcomes,
6.9 kB of JSON. Typing the same text keystroke by keystroke would add **46** more. The browser e2e
tests append 2–19 records each. A 1000-toggle session appends 2004 records: all retained by default,
345 with `retain: 200`.

## 7. Answers to the points to clarify

- **Replay.** Handlers never replay: a kernel rule, tested. So an api is never called twice by a
  late or restarted bundle. Projections replay only when they ask (`replay: true`), and only the log
  viewer does. Late subscribers are served by retained slots, not by the log.
- **Queue vs disable.** The log answers the "never lost" half: every appended record gets an outcome,
  even across a stop. Queueing is free: an event-edge action (`Add`) appends every submit, and
  overlapping handler runs are fine. Disabling is left as a per-action declaration
  (`whileRunning: "refuse" | "append"`), and the `running` it shows is derived from the log. The
  question moves out of the controller into the action's declaration.
- **A failing commit** is a failed outcome record (`cause` = the save's seq) written by the log when
  the handler throws. The form's `error` is a projection of those outcomes, cleared by the next ok
  outcome. A user notification is an explicit `shell:notify` intent appended by the handler.
- **Log size and pruning**: see the fitness table above. By default nothing prunes. The kernel's
  `retain` compacts to N when the log reaches 2N, and keeps everything at or after the oldest
  pending intent. No bundle needs history; only the viewer reads it.
- **The Todos → Contacts link** became *simpler*: a 40-LOC bundle appends a declared intent, and 0
  Contacts files changed. It did not become *looser*: `required` plus a single handler turns a
  missing answerer into an error log and a failed outcome. The link does not await the outcome, so
  it never *handles* the failure itself; the failure sits in the log and the error log.
- **Who owns shared state:** the owner's published projection. `todos.core` folds outcomes into
  `todos:collection`, which is published in a slot. See §3.1 for why "anyone may build it" fails.
- **Form edits** stay outside the log (a cell per session). Keystrokes would nearly double the log,
  and no reactor answers a keystroke. Selections, low-frequency gestures, are events in the log.

## 8. Recommendation for consolidation

Keep the **record**, drop the **sourcing**. Concretely, for CONSOLIDATION.md:

1. **Adopt "commit = record" as the commit mechanism** (ADR-012). An action's submit appends a
   typed intent whose payload is captured (cloned + frozen) by the kernel at submit time. That
   replaces controller snapshots, the submit edge and hand-written in-flight flags.
2. **Adopt kernel-written outcomes**: a handler's return or throw is recorded against its cause.
   Form errors and `running` derive from it, and a stopped bundle's in-flight work is closed as
   "abandoned" instead of dropped.
3. **Adopt per-bundle scopes** for anything that can write (append, handle, publish), closed by the
   loader or the bundle's cleanup, so that "no write after stop" is enforced and not reviewed.
4. **Keep commands' transient semantics for handlers** (no replay). Keep **slots** for state and late
   subscribers. Do not make projections replayable by other bundles.
5. Retain the log as a **bounded ring buffer for diagnostics** (viewer, tests, `since(seq)` checks),
   with the pending watermark, instead of as the source of truth.
6. If P1 (commands over slots) runs, it should fold these in: a command bus that records calls and
   outcomes *is* this log minus replay.
