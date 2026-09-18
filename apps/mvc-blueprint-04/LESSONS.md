# P0 — lessons

Prototype **P0** (`apps/mvc-blueprint-04`): ARCHITECTURE.md implemented as written, React **and** plain
DOM. Status: **DONE** — every acceptance criterion met; the definition held, with the gaps and
reinterpretations listed below.

## History (the commits are part of the evidence)

| Commit | What | Logic-bundle files touched |
| --- | --- | --- |
| `88783ab` | kernel, loader, all logic bundles, React host + renderers, node suites, React e2e | (created) |
| `3452ea1` | **plain DOM**: `kits/dom`, `shell.dom`, `*.ui.dom`, trivial DOM test shell, `workbench.dom`, standalone apps; the same e2e scenarios now run for both | **0** (17 files, all UI / features / apps / tests) |
| `6767f87` | boundary suite, dependency-graph report, LOC script | 0 |
| `cac3951` | **Rename a todo** (§14.6) in one commit | new bundle `todos.rename` + 2 API lines |

## What worked

- **The kernel is small and sufficient**: 344 LOC (context + guard, `useFields`, two bookkeeping
  subclasses, services, loader, model types). Every bundle runs on `{}`.
- **Slots' retention makes order irrelevant.** `todos.status` before `todos.core`, renderer before
  model, model before renderer, a feature activated after the shell — all tested, all work with no
  code for the case. `followFirst` (a kit helper, 20 lines) was the only pattern needed.
- **Views as publications** removed every "open/close view" API. Editors, dialogs and details panels
  are `register` / disposer; the dispose test (every slot empty, unobserved, no command listener,
  no timer) needed no production-code fix: each controller owns one registry, released in reverse.
- **The second technology touched zero logic files** (commit `3452ea1`). The DOM binding is 12 lines
  (`bind` = the contract's subscribe loop); the rest of `kits/dom` is element helpers.
- **The same e2e scenarios** (DOM-level, technology-neutral markup contract) pass under React, plain
  DOM and the trivial test shell: 10 scenarios × 2 technologies + 2 standalone runs.
- **Shared state owned by the service bundle** (`todos.core`) with writes as commands removed 03's
  `todos:changed` broadcast and every reload; five consumers (list, edit, clear-completed, status,
  rename) follow one published model.
- **Extension without edits**: interaction (1) is one 54-LOC bundle; no Contacts file mentions
  Todos. Rename was a new bundle plus a view kind; existing renderers were reused for the new kind.
- **Commit-time snapshots** in the submit listener (MODELS.md §12) were enough for every race test:
  typing after submit, typing while running, two submits in one tick, a selection changed after the
  link's submit, Clear completed acting on what was done *when asked*.

## What failed or needed a patch to the definition

1. **The read-then-set guard vs "set it unless the host already has".** Checking "already set" with
   the adapter's optional get *is* a read, so the provider's own `set` throws. Needed a non-reading
   `isProvided(ctx, key)`. The rule is right; the definition must name the non-reading probe.
2. **`Activator | (() => Promise<Activator>)` is ambiguous at runtime** — both are `() => Promise<…>`.
   The loader needs a discriminator (`lazy: true`).
3. **Coverage needs introspection the libraries do not have.** "Contributions nobody renders" is only
   answerable if the slots bus knows its observers: `KernelSlots` (40 LOC) counts them; the same
   bookkeeping (`KernelCommands.listened()`) was needed for the dispose test's "no command has a
   listener". Side effect: shared state no one reads shows as `unobserved` (informational) — the
   standalone reports flipped from `todos:selection unobserved` to complete when `todos.rename`
   began to read it, so coverage expectations are part of a feature's cost.
4. **"Effective `enabled` is derived in the model implementation"** holds only for guards over the
   same model. Every cross-bundle guard (contacts link ← `contacts:selection`; Rename ←
   `todos:selection`; Clear completed ← collection counts) is set by the **controller** from a
   synchronous listener. Still same-tick in process; would not be across a realm.
5. **Refuse mode has a same-tick hole**: the controller sets `running` a microtask after the submit,
   so a second submit in the same tick passes the model's guard. Controllers must fold it (`pending
   ??= snapshot`). Better: the action model flips a pending flag synchronously in `submit()`.
6. **The definition's Todos API lacked `todos:selection`** (Contacts had its equivalent). Any bundle
   that contributes a selection action from outside needs it.
7. **Renderers vs an app's own extension points**: renderers may not read slots, so the list
   *controller* folds `todos:toolbar-actions` / `*:selection-actions` into its presentation model.
   Works well, but the definition did not say it.
8. **Focus return** needs the last focused element, not `activeElement` at dialog time: the opener
   (Clear completed) is disabled by `running: true` and the browser blurs it. Both hosts track
   `focusin`.
9. **Heterogeneous keyed renderer slots** need an existential cast
   (`as unknown as ReactRenderer<never>`); `ViewKind<M>` types the pair only at the call site.

## Pros

- Everything is mechanically checkable: 8 boundary rules with negative controls, type-level single
  writer, contract suite on two implementations per kind, a graph with 0 violations.
- Independence is real: standalone runs load no code of the other app; removal runs log no error.
- A kernel-only bundle is 80 LOC; the kit is optional and visibly so.
- The UI layer really is replaceable: 0 logic files changed; the DOM renderers are ~1.35× the React ones (303 vs 224 LOC).

## Cons

- **26 concepts** before a newcomer can write a bundle — more than 03, mostly from structure
  (feature/application/loader/manifests) and the three model kinds.
- **Ceremony per interaction**: a feature touches an API module (keys, commands, kinds), a controller,
  a model, and two renderers. Rename: 11 files / +291 lines for one dialog (212 of them the new
  bundle, 64 of those a form model that duplicates `todos.edit`'s — private models cannot be shared
  across bundles without a kit).
- Controllers are long (todos.list 283 LOC incl. model): snapshots, update loop, running flags, and
  `active` checks are hand-written in every bundle.
- Cross-bundle writes as commands mean the owner re-implements a store's write path (patch the
  collection before resolving).
- The shell hosts are the largest UI units (≈300 LOC each), and the DOM host re-implements
  reconciliation (mount/unmount per renderer arrival).

## Fitness table

| Axis | Measurement | Value | Notes |
| --- | --- | --- | --- |
| Simplicity | concepts and rules a newcomer must learn | **26** | README lists them (kernel 8, structure 6, models 7, views & commits 5); kit concepts excluded |
| Simplicity | LOC / files of the minimal no-kit bundle (`hello`) | **80 LOC / 2 files** (logic: activator 73 + API 7) | renderers: React 20 LOC / 2 files, DOM 20 LOC / 1 file; kernel only |
| Simplicity | Rename a todo: files touched, lines +/− (logic / UI / tests) | **11 files, +291/−11** — logic 4 files +216/−0 · UI 2 files +4/−2 · tests 5 files +71/−9 | logic = new bundle (2 files, +212), API +2 (view kind), features +2; UI = register the existing editor renderer for the new kind; tests include 2 coverage expectations that changed |
| Separation | boundary suite: rules / violations | **8 rules / 0 violations**, negative control per rule | R1 renderer value imports, R2 no provide/register/call/listen/await in renderers, R3 no UI lib in logic/neutral API, R4 no DOM globals in logic, R5 cross-bundle → API only, R6 kernel imports no bundle/kit, R7 substrate private, R8 API = declarations only |
| Separation | single-writer violations | **0** | type-level over 14 view facets and 6 control facets (+2 negative controls, `@ts-expect-error`); runtime: 8 view + 6 control facets frozen and writer-free |
| Separation | domain-logic hits in views | **2** (0 await / .call / .provide / .register / service imports) | the Ctrl-click selection arithmetic in `todos.ui.react` and `todos.ui.dom` — fix: a `toggleSelected(id)` intent on the list model. Other conditionals are rendering choices (line-through, aria-current, error shown) |
| Independence | cross-bundle edges / to API modules / violations | **53 import sites (35 distinct) / 53 / 0** | fan-out 3–8 modules per bundle (logic bundles 3–8, renderers 4, hosts 4–6); report printed by `pnpm graph` |
| Independence | standalone runs (Todos, Contacts) | **pass / pass** | headless test shell (node) and trivial DOM test shell (Chromium) |
| Independence | removal runs: errors / coverage report | **4 runs, 0 error logs** | without `todos-contacts`: `unobserved contacts:selection`; without `todos.status`: complete; without `contacts` (+`todos-contacts`): complete; without `todos` (+`todos.status`, `todos-contacts`): `unobserved contacts:selection` |
| Composability | interactions (1)–(3) pass | **3/3** under React, DOM and headless | (3) also with Contacts removed and Todos removed |
| Composability | files changed in Contacts for interaction (1) | **0** | no `contacts.*` file mentions Todos; the link is one bundle in its own feature |
| Composability | second UI technology: logic files changed / new UI LOC | **0 / 791** | binding kit 78 (the binding itself 12) · renderers 303 (todos 156, contacts 127, hello 20) · host `shell.dom` 304 · trivial DOM test shell 106 |
| Correctness gate | contract · commit races · dispose · late subscriber · read-then-set | **green** | contract 83 tests (3 kinds × kit + hand-rolled implementations, hello through its bundle, point 9, 7 suite negative controls) + single writer 4; commits 9; dispose 4; late 3; read-then-set 7 + loader 7 |

Totals: node 150 tests, Chromium 24 tests. LOC (non-test): kernel 344, kits 573, API modules 288,
logic bundles 1758, UI bundles 1232, features/apps/main 191; tests 2348 (`pnpm loc`).

## Answers to the points to clarify

- **Queue or disable?** Save (both editors), Clear completed, Toggle/Edit/Delete and Rename
  **refuse** (`running: true`, button disabled + `aria-busy`); Add **queues**. User-visible
  difference, pinned by tests: a refused second Save produces one api call and the button is
  disabled meanwhile; three Adds while the first runs keep the button enabled and land in order with
  their own titles. Queue costs a snapshot *list* instead of one snapshot; refuse needs the
  same-tick fold (lesson 5). Recommendation: refuse by default, queue for event-edge actions.
- **Owner of `todos:collection`?** `todos.core` (the service owner). Simpler: one writer, no
  change broadcast, no reloads, consumers in any order. Cost: every write is a command in the API
  (3 commands), handlers must publish before resolving, and `todos.core` does optimistic patching.
  A domain-controller owner would have put the write path in `todos.list`, making Rename and the
  contacts link depend on the list bundle's presence — worse for removal.
- **Was one flat context a problem?** No clash. One reach we could not prevent: `todos:api` is
  declared in the Todos API (the host must be able to set it), so any bundle *could* read it and
  write around the owner's commands. That is the only case for scoping seen; a boundary rule ("only
  the owner resolves `todos:api`") would cover it without scopes. `sys:config` became a second flat
  namespace inside one service.
- **Did activation order matter beyond "required first"?** Only for services: a provider before any
  bundle that reads its key (checked statically from `provides`/`requires`/`optional`, and at
  runtime by the guard — both tested), and host keys (`shell:root`, `sys:logger`, `sys:config`) set
  before `application()` (the loader itself reads `sys:logger`). Slots and commands: no.
- **Was the shell API sufficient?** Yes, plus two services: `shell:root` (where a DOM host renders)
  and `shell:coverage` (the report). No new extension points. Tab selection is host-local state.
- **How much of 03's kit was kept?** The signals wrapper, `stableGroup`/channels, the action model
  (+ a `queue` option), the update loop and `attempt`; `watchSubmits` became `onSubmits`
  (synchronous, per batch). New small kits: `slots` (`followFirst`), `notify`, `host` (coverage),
  `react`, `dom`. A newcomer does not need the kit for a first bundle (`hello`), but every real
  bundle here uses it; without it the list/editor models would roughly double.
- **What had to be reinterpreted?** See "What failed" 1–9 and the README's choices table: the
  non-reading probe, the lazy discriminator, coverage via observer counts, cross-bundle guards set
  by controllers, the missing `todos:selection`, controllers folding action extension points into
  models, write commands on the owner, `sys:config` for the timeout, `shell:root`.

## Recommendation for consolidation

Keep the definition's core — flat context with the guard, slots/commands/registry, bundles/features
with a loader, views as publications, per-technology renderers, the model contract with facets.
Amend: (1) name `isProvided` and a manifest `lazy` flag; add `provides/requires/optional` to bundle
manifests and let the loader check them; (2) make shared state's write path explicit (owner-answered
commands) and add `todos:selection`; (3) specify that controllers fold an app's own extension points
into presentation models; (4) define coverage as "unrendered kinds + unobserved slots" and require
the bus bookkeeping in the kernel; (5) let the action model refuse same-tick resubmits itself; (6)
allow cross-bundle guards to be controller-set base flags. To cut the concept count and per-feature
ceremony, look at P3 (commit mechanism in the model) and P2 (controller shape) — the hand-written
snapshot/loop/`active` pattern is the largest repeated cost here.
