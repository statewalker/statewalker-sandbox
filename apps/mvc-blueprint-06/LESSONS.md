# R2 — Actors: lessons

Status: **done**. The full benchmark (§14) runs on same-thread actors with React: workbench,
standalone Todos and Contacts, removal runs, `hello`, Rename a todo. 91 node tests + 17 Chromium
tests green; typecheck, biome and `vite build` clean. No new dependency.

## What worked

- **The kernel is small and the semantics are crisp.** One FIFO run queue, synchronous
  run-to-completion handlers, async work re-entering as a *turn* (`ctx.pipe`, `ctx.after`, stream
  and presence callbacks). 735 LOC of kernel including the loader, stream hub and extension points.
- **"Nothing happens after deactivation" is structural, not a discipline.** A stopped actor's
  turns, timers, pipes, sends and publishes are dropped by the kernel; its streams are released, its
  subscriptions and watches cancelled, its queued asks rejected. The dispose test (no actor, no
  stream value, no listener, no delivery, no turn after cleanup — even with pending notification
  timers and a save in flight) passed without any per-bundle cleanup code. P0's rule "after any
  `await`, check you are still active" has no counterpart because there is no `await` in a handler.
- **Commit time falls out of mailbox order.** Every keystroke is a message to the draft's owner; a
  Save is a message behind them. What was typed before Save is in the commit; what is typed after
  is the next commit. No snapshot mechanism, no form `commit()`; the race tests (edit → Save → keep
  typing while it runs; two Saves in one tick; Add while adding; Clear completed captured at ask
  time; interaction (1) reading the selection at commit time) all pass.
- **Synchronous drain keeps controlled inputs honest.** Because a send from outside any actor drains
  the queue before returning, a keystroke's state comes back inside the same DOM event. The
  real-keyboard test (type, move the caret, type) keeps the caret. An async mailbox would break this.
- **Independence is mechanically visible.** Every cross-bundle edge goes to an API module (28/28);
  two workbenches in one process share nothing (runtime test); removal of any feature leaves no
  error-level log and no dead letter; features can arrive and leave at runtime.
- **Views are the thinnest of any design so far.** A renderer receives `{ state, send, dispatch }`
  and nothing else: no model objects, no facets, no subscriptions of its own. 1 domain-logic hit.
- **Worker readiness of the logic is real.** With the clone check on, every message, reply and
  stream value across the whole scenario is structured-cloneable (0 failures). Only renderer
  contributions (components) fail — as expected.

## What failed (or bit)

- **Slots came back, under another name.** An extension point without a kernel slot is: the owner
  holds the contributions (`ownPoints`), publishes them as a stream, and *monitors every
  contributor* to drop a stopped one's entries; the contributor *watches the owner's presence* and
  re-sends when it (re)appears. That is 123 LOC (`extension.ts`) re-implementing a retained keyed
  slot, plus a presence mechanism (`watch`) the kernel needs only for it. The shell actor is
  literally an 11-line "registry actor". The concept count did not drop; it moved.
- **Identity → value equality, and a ping-pong loop.** The first headless run hung: `todos.list`
  renders → re-sends its own action contributions → the point republishes → `todos.list` (a
  subscriber of its own point) renders again → … forever. Messages carry fresh objects, so
  "changed?" can only be asked by value. Fixed with `deepEqual` in `contribute().update` and in the
  owner's `handle`. P0 never has this class of bug; every actor design will.
- **"Never mirrored" (ADR-009) is broken by construction.** A consumer receives stream values into
  its own state (`todos.edit` holds `todos` and `selected`; `contacts.edit` holds `contacts` and
  `selected`). The copies are correct only because delivery is ordered — but they are copies.
- **Asks are a sharp tool.** A handler that forgets `env.ok()` hangs the caller until the actor
  stops (then `ActorStopped`). Typing replies needed a discriminant trick
  (`ReplyTo<N, T>` over the message `type`); the first, naive typing inferred `Todo | number`.
- **Focus return** failed once in e2e — not an actor issue: the test focused a menu item inside a
  closed `<details>`. A real one surfaced next to it: disabling "Clear completed" while its dialog is
  up blurs the opener, so focus cannot return; the action now stays enabled (a second ask is a
  no-op).

## Pros

- Deactivation safety and commit-time semantics are properties of the runtime, not of each author.
- The strongest isolation of any design: nothing to read but streams, nothing to call but addresses.
- A renderer cannot do anything but render and express intent.
- A clear path to workers for service actors (all traffic already cloneable).
- Contribution ownership is explicit: the owner can police ids (a second contributor claiming an id
  is refused loudly), and cleanup follows the contributor's lifetime automatically.

## Cons

- Every piece of shared state needs a stream key, an owner, a message protocol to change it, and a
  consumer-side copy. Services become actors: every api call is an `ask` whose result comes back as
  a turn (`ctx.pipe`), so straight-line async code becomes callback-shaped.
- Extension points = slots + presence + monitors, rebuilt in userland.
- Value equality everywhere (or loops); deep compares on every contribution update.
- A flat global namespace remains (addresses, stream keys), exactly like the flat context.
- Bundle files are longer than P0-style controllers would be: `contacts.edit` 157 LOC,
  `todos.edit` 166 LOC — actions are re-described as data on every change.
- Workers would need a new kernel (mirrored stream hub, serialized envelopes, ask correlation,
  presence events), and a view whose inbox lives in a worker loses the synchronous keystroke
  round-trip — form actors must stay on the main thread or views need a local echo.

## Fitness table

| Axis | Measurement | Value | Notes |
| --- | --- | --- | --- |
| Simplicity | concepts and rules a newcomer must learn | 12 concepts + 5 rules | README; `hello` uses 9 of the concepts |
| Simplicity | LOC / files of the minimal no-kit bundle (`hello`) | 63 LOC / 3 files | logic 37/1 + API 6/1 + React renderer 20/1 |
| Simplicity | Rename a todo: files touched, lines +/− (logic / UI / tests) | 7 files, +225/−2: logic 3 files +138/−0 · UI 2 files +25/−2 · tests 2 files +62/−0 | new bundle `todos.rename` (115 LOC); commit `c3a90c4` |
| Separation | boundary suite: rules / violations | 7 rules + graph rule / 0 | a negative control per rule; includes "no module-level mutable state" |
| Separation | single-writer violations | 0 | runtime: a second publisher of a stream throws; type test: views get no writer |
| Separation | domain-logic hits in views | 1 | Enter in "New todo" looks up the toolbar action with id `add` (fix: put the submit action in `ListState`) |
| Independence | cross-bundle edges / to API modules / violations | 28 / 28 / 0 | 16 bundles; max fan-out 4 (`pnpm deps`) |
| Independence | standalone runs (Todos, Contacts) | pass / pass | headless test shell and React |
| Independence | removal runs: errors / coverage report | 0 errors, 0 dead letters, coverage empty in all 4 | removing `contacts` also drops `todos-contacts`; removing `todos` drops `todos.status`, `todos-contacts` |
| Composability | interactions (1)–(3) pass | 3/3 | headless and React e2e |
| Composability | files changed in Contacts for interaction (1) | 0 | `todos.contacts-link` imports the Contacts API only |
| Composability | second UI technology: logic files changed / new UI LOC | n/a | React only, per the brief |
| Correctness gate | contract · commit races · dispose · late subscriber · read-then-set | 20/20 · 7/7 · 1/1 (+3 kernel stop tests) · 5/5 · n/a | contract = MODELS.md §4 on streams, kernel + hand-rolled impl; read-then-set has nothing to guard (no shared context) |

Other measurements:

- Keystroke cost (headless): **1 delivery + 1 stream notification per keystroke, ~4 µs**; in the
  browser **1.2 messages per keystroke** (the Add action's `enabled` flips once).
- Todos scenario: 54 message deliveries (shell 17, todos.list 25) plus stream/presence turns.
- Kernel 735 LOC; whole `src` 2747 LOC; tests 1782 LOC.

## Answers to the points to clarify

- **How does the shell learn about panels, menu items and renderers?** By messages to the actor that
  owns the extension point (`shell` for `shell:*`, `shell.react` for `ui.react:renderers`), which
  keeps them and publishes each point as a retained stream the host renders. Late joiners are
  handled by the contributor watching the owner's presence and re-sending. A registry actor *does*
  reappear — the `shell` actor is one — and it is a slot under another name, with ownership made
  explicit.
- **What happens to a message sent to a removed bundle?** A tell is a dead letter (recorded, logged
  at `info`, never an error); an ask rejects with `NoSuchActor` (that is the "required" command
  policy); messages already queued when it stops are rejected (`ActorStopped`) or dead-lettered;
  its contributions vanish because each owner monitors its contributors; its streams become absent
  (`undefined`) and subscribers see that.
- **How does a view send a form edit?** A message per keystroke to the owner of the draft. Cost:
  one delivery and one stream notification (~4 µs headless). It works with controlled inputs only
  because the scheduler drains synchronously; an async mailbox would need a local echo in the view.
- **Could any bundle move to a worker without code changes?** Bundle code, mostly yes — all logic
  traffic is structured-cloneable and bundles use only `ctx`. The *kernel* would need a worker
  transport. `todos.core`, `contacts.core`, `todos.status`, `todos.contacts-link` and `shell` could
  move; `todos.list` / `todos.edit` / `contacts.edit` / `todos.rename` could but their forms would
  lose the synchronous keystroke round-trip; `shell.react` and the `*.ui.react` bundles cannot
  (components in messages, the DOM, `ctx.viewPort()` synchronous reads).
- **Does "no shared context" remove a class of bugs P0 has, or only move them?** It removes:
  read-then-set / replaced-after-read, writes after deactivation, direct cross-bundle mutation,
  hidden coupling through shared objects. It moves: key clashes (addresses and stream keys are one
  flat namespace — "already taken" / "owned by" throw instead), ordering (now mailbox order —
  easier to reason about), and "model identity" (now value equality, which introduced a new bug
  class: re-send ping-pong). It adds: hanging asks and consumer-side copies of shared state.

## Recommendation for consolidation

Do not adopt actors as the architecture; adopt three of their properties into it.

1. **Deactivation safety by construction**: give controllers a way to run async results as
   *turns* that the kernel drops after cleanup (`pipe` / `after`), instead of the "check you are
   still active after every `await`" rule.
2. **Commit time as ordering**: when the form draft and the commit are handled by one serialized
   owner, commit time needs no separate mechanism. Worth comparing with P3's mechanisms.
3. **Views receive `{ state, send, dispatch }`**: actions as plain data (`ActionDesc`) and views that
   cannot hold model objects are simpler to check and to port.

Keep slots as a kernel primitive: R2 had to rebuild them (plus presence and monitors) to express
extension points, so removing them bought nothing. Keep shared state as a published model rather
than copied streams unless workers become a real requirement — only then does the actor boundary
pay for its costs (value equality, consumer copies, callback-shaped async).
