# R1 — lessons (Elm/MVI single store)

Status: **done**. The whole benchmark runs on one store with no controllers and no action models:
65 node tests and 17 Chromium e2e tests pass; typecheck, build and biome are clean. Numbers below
come from `node scripts/loc.mjs`, `node scripts/deps.mjs`, `git show --numstat a084188` and the
suites under `tests/`.

## The shape, in one paragraph

The kernel is the context (with the read-then-set guard), the loader, a logger and **one store**
(`src/kernel/store.ts`, 424 LOC). A bundle's activator only *wires*: `store.addSlice({ id, init,
update, subscriptions })` registers a pure update over its own slice; `slice.contribute(point, key,
derive)` publishes a *derivation* of that slice to an extension point; `store.addEffectHandler(type,
fn)` performs effect values that updates return. Messages are processed one at a time from a queue
and **broadcast to every slice** (the "update-function extension point"). Views receive frozen
plain data (`props`) and `dispatch`. The shell host is a set of selectors: header =
`select(shellHeader)`, panels = `select(shellPanels)`, and so on.

## What worked

- **Commit-time semantics by construction.** Updates run serially over the state as of their
  message, and `select` inside an update evaluates points over that same state. Save reads the
  draft, the link reads the selection, Clear completed reads the ids captured when asked — no
  snapshot mechanism, no "still active" checks. The race suite (edit → save → keep typing; two
  saves in one tick; forged second dispatch; a cancelled session's late outcome) passed on the first
  run. The effect value *is* the commit record: `contacts.edit` returns
  `{ type: "contacts/update", id, patch: draft, ref }`, and the reply echoes `patch` back.
- **Single writer by construction.** The store computes `root[slice.id] = slice.update(...)`; an
  update receives only its own slice and a read-only `select`; committed state and derived views
  are deep-frozen; a second `addSlice` with the same id throws. The test
  (`tests/single-writer/single-writer.test.ts`) shows a view and another update both failing to
  write, and the type-level signature. The three model kinds collapse into one: presentation =
  derived props, form = slice fields written on intent messages, action = `ActionItem` data.
- **Derived views made arrival order trivial.** A contribution is a function of state, so "late
  subscriber" is not a case: `todos.status` activated before `todos.core` derives `[]` and then the
  count; renderer-before-model and model-before-renderer both work in the browser; a feature
  activated after the shell appears and disappears without a reload. The only retained thing is
  the registry of derivations.
- **Removal leaves nothing dangling.** A bundle's slice leaves the state with it, and the buttons
  that would dispatch its messages are derived from its state — so they are gone too. Across the
  four removal runs, no error was logged and no message went unanswered (`idleMessages: []`).
- **Dispose is one mechanism.** Every effect runs with an `AbortSignal` owned by the slice that
  emitted it *and* by its handler; withdrawing either aborts it and drops its late `dispatch`
  (logged at debug). Timers are subscriptions (data diffed by key), so they stop when the state
  stops declaring them or the slice leaves. After the application's cleanup, `store.inspect()` is
  all zeros.
- **Views are really dumb.** Renderers import only API modules and the kernel's view types; the
  boundary suite forbids store, service and effect imports in view files (0 violations).
- **The headless test shell is the store itself.** `select(point)` is exactly what a host renders,
  so the whole benchmark is tested in node (`tests/support/user.ts` "presses" `ActionItem`s) and
  the e2e suite repeats the same scenarios through React.
- **Cross-bundle composition through the extension point is cheap.** `todos.contacts-link` is one
  file, 38 LOC, imports two API modules, and edits nothing in Contacts. The classic TEA
  alternative (`tests/composition/tea-nesting.test.ts`) needs a parent that names every child in
  its Model, Msg, init and update, and the link becomes a branch *in the parent*.

## What failed (or cost more than expected)

- **Request/response had to be re-invented.** With no commands, every "call the owner and hear
  back" became an effect plus a reply message with a correlation `ref`: `todos.list` (Add),
  `todos.edit`, `todos.clear-completed`, `todos.rename`, `contacts.edit` each repeat
  `if (msg.type === REPLY && reply.ref === session.id)`. The reply type is a *string* the requester
  passes in the effect, so the reply is not typed end to end (`msg as TodoReply`). This is TEA's
  `Task.attempt ToMsg` without functions-as-data; the boilerplate is at every commit site.
- **A read-at-commit needs a slice.** `todos.contacts-link` holds no state, yet it must register a
  slice only to own an update function that reads the selection when its message arrives.
- **API modules grew.** They now declare view *intents* (the messages a renderer dispatches, e.g.
  `todosListIntents`), the api effects and their reply shapes, and two points P0 does not have
  (`todos:selection`, `contacts:collection`). In P0 the same surface is the view facet of a model.
- **Broadcast costs.** Every message visits every update, and every state change invalidates
  every derivation (the memo is per root, not per slice), so each keystroke re-derives every panel
  and React re-renders every panel. Invisible at this size; at scale it needs per-slice memoisation
  (reselect-style) or per-point change detection.
- **Stale responses are the author's problem.** Two in-flight `todos/api` effects each dispatch a
  fresh `todos.core/loaded`; ordering relies on the api answering in order. TEA has no
  `takeLatest`; a generation counter would have to be written by hand.
- **Small typing traps.** A payload-less `defineMsg` narrowed the `false` branch of `match` to
  `never` until the matched type got a phantom brand; `next(state, ...effects)` needs a branded
  result so an update can return either a state or a state-with-effects.
- **No command response semantics.** `todos:edit:open` "resolves when the editor is published" has
  no equivalent: a message is fire-and-forget; the caller would have to observe state.

## Pros

- Correctness gate is nearly free: serialized pure updates give commit-time semantics, single
  writer and dispose without per-bundle discipline.
- Fewer concepts than P0's controller/model split (no model contract, no facets, no action model,
  no submit edges, no still-active checks, no commands).
- Everything a user sees is `f(state)`: arrival order, late subscribers and removal need no
  special cases; the store is the test shell.
- Effects as values are inspectable and testable without running them.
- Renderers are pure functions of plain data plus `dispatch` — the cheapest possible UI contract.

## Cons

- Request/response, correlation and stale-response handling are hand-written at every commit site.
- Stateless behaviour (a link) still needs a slice.
- Every update sees every message; message namespaces are a convention (nothing stops a bundle
  from reacting to another bundle's private message type — only review and the boundary suite on
  imports do).
- Broadcast + whole-root memo re-derives everything on every keystroke.
- The API module carries more: intents, effects, reply shapes.

## Fitness table

| Axis | Measurement | Value | Notes |
| --- | --- | --- | --- |
| Simplicity | concepts and rules a newcomer must learn | **20** (13 concepts + 7 rules) | listed in README; `disposers`/`defineMsg` are kernel helpers, not extra concepts |
| Simplicity | LOC / files of the minimal no-kit bundle (`hello`) | **55 LOC / 2 files** logic (api 2 + index 53) + **16 LOC / 2 files** renderer | biome expands the object literals; kernel only |
| Simplicity | Rename a todo: files touched, lines +/− (logic / UI / tests) | **8 files**; logic +130/−0 (new bundle 118, API 10, features 2); UI +38/−2; tests +62/−0 | commit `a084188`, a new bundle `todos.rename`; no existing logic edited |
| Separation | boundary suite: rules / violations | **5 rules / 0 violations**, 5 negative controls | `tests/boundaries`, regex import graph (`scripts/graph.mjs`) |
| Separation | single-writer violations | **0** | by construction; test shows view and foreign-update writes throw, second writer throws |
| Separation | domain-logic hits in views | **1** (of 9 conditionals) | `todos.ui.react/views.tsx:34` finds the Add action by id for Enter-to-submit (fix: a `defaultAction` prop). The other 8 are rendering choices: 3 `enabled` guards mirroring the disabled button on form submit, 3 `error &&`, 1 plural, 1 strike-through |
| Independence | cross-bundle edges / to API modules / violations | **36 / 36 / 0** | fan-out ≤ 2 for every bundle (`node scripts/deps.mjs`) |
| Independence | standalone runs (Todos, Contacts) | **pass / pass** | node scenario suites run on `shell` + one app; `todos.standalone`, `contacts.standalone` in Chromium |
| Independence | removal runs: errors / coverage report | **0 errors** in all 4 (`todos-contacts`, `todos.status`, Contacts, Todos) | store coverage: `idleMessages: []`, `unhandledEffects: []`; host: no missing renderers |
| Composability | interactions (1)–(3) pass | **yes** (node + Chromium) | |
| Composability | files changed in Contacts for interaction (1) | **0** | `todos.contacts-link` imports `contacts/api` + `todos/api` only; no contacts file mentions todos |
| Composability | second UI technology: logic files changed / new UI LOC | **n/a** | R1 is React-only by brief; logic bundles import no UI library (boundary rule), so the expected change is 0 logic files; binding is 20 LOC, host 230 LOC |
| Correctness gate | contract · commit races · dispose · late subscriber · read-then-set | **pass · pass · pass · pass · pass** | store contract 15 tests; commit races 4; dispose 3 (+2 in contract); late subscriber 2 node + 2 browser; read-then-set 2 |

Totals: `src` 39 files / 2 615 LOC (kernel 616, of which store 424; shell.react 266); tests 15 files /
1 529 LOC.

## Mapping: P0 concept → R1

| P0 concept | R1 counterpart |
| --- | --- |
| Context + adapters, read-then-set, `useFields` | same (the store is `sys:store`) |
| Slots (retained pub/sub) | **points**: registered derivations over state; "retained" by construction |
| Commands (`call` → response; required/silent) | **public messages** (fire-and-forget) + **effect with reply type and `ref`**; no response, no policy |
| Controller / activator | activator = wiring only; behaviour in `update` |
| Sub-controller | none — nested state in the slice |
| Presentation model | derived contribution `props` |
| Form / input model | slice fields written by `update` on view-intent messages |
| Action model (`submit`, `enabled`, `running`) | `ActionItem` data; `submit()` = `dispatch(item.msg)` |
| Model contract (`getX`/`onXUpdate`, facets, 9 timing points) | `store.subscribe` + `select`; one notification per processed message |
| "check still active after `await`" | effect `AbortSignal`; late `dispatch` dropped |
| `todos:collection` slot owned by `todos.core` | point derived from the `todos.core` slice |
| Notifications published by their owner | `shell.core` slice + `shell/notify`; timeout = subscription |
| Renderer `({ model })` + `useModel` | renderer `({ props, dispatch })` + `usePoint` |
| Coverage report | host: missing renderers; store: idle messages, unhandled effects, unread points |
| Logger, loader, bundles, features, applications | same |
| Disposal registry | `disposers(...)` |
| Kernel model module (`ActionView`, …) | `kernel/views.ts` (`ActionItem`, `ViewKind`, `Dispatch`) |

## Answers to the points to clarify

- **How is `todos:collection` exposed?** As a point with one contribution, derived by `todos.core`
  from its slice: `{ todos, counts }`. `todos.status` is a pure derivation of it (no slice); the
  Contacts link does not need it. Updates read it with `select` (state before their message).
  Not a selector function exported by the API — that would put code in the API module and couple
  consumers to the slice's shape.
- **Can a bundle be removed without dead slices or unhandled messages?** Yes. The slice is removed
  with the bundle; effects it emitted are aborted; the actions that would message it are derived
  from its state and vanish with it. A message nobody acts on is recorded in
  `coverage().idleMessages` (no error); the removal runs recorded none.
- **Where do effects live, and how are they cancelled?** Effects are values returned by updates;
  handlers are registered by the bundle that owns the service (`todos.core` performs `todos/api`).
  Each effect has an `AbortSignal`, aborted when its emitting slice or its handler is withdrawn;
  its late `dispatch` is dropped. Timers are subscriptions (`afterSub`), diffed by key and stopped
  when the state no longer declares them or the slice leaves.
- **How does "New todo for this contact" read the selection at commit time?** Its button dispatches
  a payload-less message; the link's update reads `select(contactsSelection)` over the state as of
  that message and returns `dispatchFx(todosCompose({ title }))`. The test selects Ada, captures the
  button, selects Grace, presses — the todo is for Grace.
- **Did derived views make renderer-arrival order trivial or harder?** Trivial. Nothing is
  published at a moment in time; everything is recomputed from state, so order stops mattering
  beyond "required features first" (not even that for pure derivations).
- **What would UI replacement cost compared with P0?** Less: the binding is one hook over
  `subscribe` + `select` (20 LOC), renderers are pure functions of plain data, and there is no
  per-model subscription to port. The host (230 LOC) and renderers must be rewritten per
  technology, as in P0. Not measured — React only by brief.
- **Who owns shared state?** The bundle whose slice holds it (`todos.core`), and only its update
  writes it; others change it through the `todos/api` effect `todos.core` performs.
- **Queue vs disable?** Disable: the update sets `saving/running` synchronously, the ActionItem
  shows it, and a second commit message is a no-op.
- **How do independent bundles and the shell compose, and how does a second bundle contribute to
  the first's extension point?** Messages broadcast to every slice; the shell and each app own their
  slices and declare points in their API modules. A second bundle contributes to the first's point
  by `slice.contribute(firstApi.point, key, derive)` (the link to `contacts:selection-actions`;
  `todos.edit`/`todos.rename` to `todos:selection-actions`), and the owner's panel derivation
  `select`s that point. With classic wrapper-Msg/`Cmd.map` nesting, the same interaction must be
  written inside the parent that knows both apps.

## Recommendation for consolidation

Keep the **controller/model split out of the default path**, and adopt from R1:

1. **Effects as values + serialized pure updates** for commit-carrying logic. They give §10's
   commit-time rules, the single-writer rule and dispose-without-late-writes by construction.
2. **Published views as derivations of owner state** (points instead of imperatively published
   slots). They remove late-subscriber, arrival-order and removal special cases.
3. **Renderers as `({ props, dispatch })`** over plain frozen data.

Do not adopt as-is:

- **Fire-and-forget messages as the only cross-bundle verb.** Restore a typed request/response
  (an effect whose handler resolves to a typed reply the kernel correlates) so `ref`/reply-type
  boilerplate disappears from commit sites.
- **Broadcast to every update without per-slice memoisation** at larger scale: add per-slice
  change detection for derivations, and consider addressing public messages to their declaring
  bundle (a message namespace = its owner) so a slice cannot silently react to another's private
  messages.
- **A slice just to read at commit time**: allow a stateless "reducer" contribution
  (`store.addUpdate`) for bundles like the link.

A consolidated design would be "one store per application, slices as the only state, points as the
only publication, effects + typed replies as the only IO" — P0's bundles, features, API modules,
loader and host kept unchanged around it.
