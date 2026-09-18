# U1 — lessons

Prototype **U1** (`apps/mvc-blueprint-08`): P0's logic, unchanged, under **Svelte 5, Solid and Vue 3**,
plus one mixed shell (Svelte renderers inside the Solid shell). Status: **DONE**. Every acceptance
criterion is met, and Vue and the optional mixed-shell experiment are done too.

## History

| Commit | What | P0 logic files changed |
| --- | --- | --- |
| `753af27` | 42 logic files copied, byte-identity test; Svelte, Solid, Vue: binding kit, renderer extension point, shell host, renderers; P0's e2e verbatim ×3; standalone ×3; flush; binding probe; boundary suite + R9 | **0** (sha-256 equal, 42/42) |
| `7b2071d` | `bridge.svelte-in-solid` and the mixed workbench; R10 | 0 |

`git diff 1257507 -- apps/mvc-blueprint-04` is empty on this branch.

## What worked

- **Zero logic changes, under three technologies.** No model, controller, API module, kit or kernel
  file changed. The test asserts it per file and derives the file set from P0's tree by rule, not from
  a hand-written list.
- **P0's e2e scenarios ran verbatim** (`dom.ts` and `scenarios.ts` are byte-identical). This covers
  Todos basics, Contacts with a failing save, (1) new todo for a contact, (2) the header count,
  (3) the merged menu (also with Contacts removed and with Todos removed), Rename, hello, and focus
  return. All passed on the first run under all three technologies. The markup contract (roles,
  `data-*`, labels) carried over as-is.
- **The bindings are tiny**: Solid 8 lines, Vue 12, Svelte 16 (3 of them are the store adapter and the
  rest is an identity check). Each host reuses the same binding for the slots bus: `getSnapshot` plus
  `observe` follow the model contract, so a slot is just another model group.
- **Svelte's store contract is the model contract.** Point 1 (the listener is called immediately) is
  exactly what `$store` expects, and the probe shows Svelte is the only binding with one read at mount
  (Solid and Vue read twice).
- **Solid needs no flush.** It writes the DOM inside our synchronous notification, so the page is
  updated before `submit()` returns, as with plain DOM. Svelte needs `flushSync()` and Vue needs
  `await nextTick()`. `tests/e2e/flush.test.ts` pins all three.
- **Two technologies can share one shell with no host change.** A 36-LOC bridge bundle follows
  `ui.svelte:renderers` and registers a Solid "island" per kind into `ui.solid:renderers`, using the
  public `mount`/`unmount` inside a Solid component. The mixed workbench passes (1), (2), the Todos and
  Contacts scenarios and hello. When the Svelte Contacts feature is removed, the coverage report shows
  its kind as `unrendered` and no error is logged.
- **The boundary suite extended mechanically.** The changes were: `.svelte` `<script>` import parsing,
  three technology names in the regexes, R9 (a technology's UI imports no other technology) and R10 (a
  bridge touches only renderer extension points). Result: 10 rules, 0 violations, each rule with a
  negative control. The suite caught the bridge on its first run: it was not yet classified as UI, so
  it counted as logic importing `svelte`.

## What failed or needed care (none of it in the logic)

1. **Svelte treats every object a store emits as changed** (`safe_not_equal`). Contract point 7 does
   not help Svelte by itself. Measured before the fix: 10 no-op notifications with a *stable* snapshot
   caused 40 property reads (template re-runs). The Svelte binding now drops a notification whose
   snapshot kept its identity, which brought that to 0. So the Svelte binding owns the dedupe, while in
   Solid and Vue the signal or ref does it.
2. **Setup-once components read the model once.** Solid components and Vue `setup()` run once. If a
   contribution's model were replaced under the same panel id, they would keep the old one. React's
   `useSyncExternalStore` re-subscribes, and so does Svelte's `$derived(modelStore(model…))`. The Solid
   host keys by contribution (`<Show keyed>`) and the Vue host keys by model identity (`identityKey`).
   This is a host rule the definition does not state.
3. **Solid's `<For>` keys by reference.** Iterating a keyed slot's `[id, contribution]` tuples (new
   arrays on every snapshot) would re-create every panel, and its inputs, on every change. The host
   iterates ids through a memo with array equality instead. Separately, a `useModel` call placed inside
   a JSX expression re-subscribes each time that expression re-runs, so every subscription has to be
   in component setup. That is a rule for Solid code, not something the contract says.
4. **Svelte's `$` prefix is overloaded.** A store named `state` makes `$state` the rune, so the name
   is unusable. Also, `$store` works only on top-level component variables, so each per-item
   subscription (header item, menu item, toast, action button) needs its own component. The result is
   7 files in the Svelte host versus 2 in the Solid host and 2 in the Vue host.
5. **Controlled checkboxes are React behaviour.** React puts `checked` back to the rendered value
   after `onChange`, and Svelte, Solid and Vue do not. P0's DOM renderer let the DOM toggle
   optimistically. Here the click handler restores the model's value before `submit()`, so the model
   stays the single writer.
6. **Friction from the tooling, not the architecture.** `vite-plugin-solid` defaults Vitest's
   environment to jsdom, so the browser config has to set `environment: "node"`. Vue's esm-bundler
   build needs `define` flags. Biome does not see `.svelte` template usage, which needed an app-level
   override for `noUnusedVariables`/`noUnusedImports`. `tsc` does not check `.svelte`, which needed
   `svelte-check`. Vue with `h()` needs no plugin and no `vue-tsc`.

## Pros

- The architecture's claim holds, with numbers: **0 logic files changed** for three more technologies,
  and 13 renderer files per technology set (7 for Svelte).
- A binding is 8–16 lines and relies on points 1, 4 and 7 only. No technology needed a new guarantee.
- The e2e layer is technology-neutral. Adding a technology means adding one row to the test table.
- Mixing technologies is a renderer-slot adapter (36 LOC), not a host feature.

## Cons

- **The shell host is the expensive part** in every technology: 217–288 LOC, re-implementing tabs,
  menu grouping, dialogs, focus return and toasts each time. The host is where most of a new
  technology's cost goes (44–50% of it), not the renderers.
- Each technology has its own rules a renderer author must know: Solid (subscribe in setup; `For` by
  reference; no destructuring of props), Svelte (one component per subscription; `$` names; `mount`
  does not flush), Vue (`shallowRef`, not `ref`; `nextTick`). These rules are about the technology,
  not the contract, but they decide whether a renderer is correct.
- The existential cast on renderer registration (`as unknown as XRenderer<never>`, P0 lesson 9)
  repeats for every technology.

## Fitness table

| Axis | Measurement | Value | Notes |
| --- | --- | --- | --- |
| Simplicity | concepts and rules a newcomer must learn | **26 (P0) + 3 per technology** | P0's 26 are unchanged. A renderer author also learns: the binding, the renderer contribution `{kind, component}`, and the technology's flush. Plus technology rules: Solid (setup-only subscriptions, `For` by reference), Svelte (one component per subscription), Vue (`shallowRef`, keyed setup) |
| Simplicity | LOC / files of the minimal no-kit bundle (`hello`) | **logic 80 / 2 (P0's, unchanged)**; renderers Svelte 19 / 2, Solid 20 / 2, Vue 23 / 2 | React 20, DOM 20 in P0 |
| Simplicity | Rename a todo: files touched, lines +/− (logic / UI / tests) | **logic 0 / UI 1 line per technology / tests 0** | the rename kind reuses the editor renderer: `add(todoRenameKind, TodoEditor)` in each `todos.ui.<tech>/index.ts` |
| Separation | boundary suite: rules / violations | **10 rules / 0 violations**, negative control per rule | P0's R1–R8 extended to `.svelte` and three technologies; R9: no cross-technology import in a technology's UI; R10: a bridge touches renderer extension points only |
| Separation | single-writer violations | **0** | logic unchanged (P0's type-level suite covers it); renderers write only through view facets (R2). The checkbox restores the model's value instead of keeping the DOM's |
| Separation | domain-logic hits in views | **3** (one per technology) | the same Ctrl-click selection arithmetic P0 found in React and DOM; the fix is the same (`toggleSelected(id)` on the list model), and it is a logic change U1 must not make |
| Independence | cross-bundle edges / to API modules / violations | **0 violations**; UI bundles fan out to 4 modules (renderers) and 6 (hosts) | `pnpm graph` prints it; logic bundles' fan-out is identical to P0's |
| Independence | standalone runs (Todos, Contacts) | **pass / pass under each of Svelte, Solid, Vue** (6 runs) | each technology's own shell with one app's features |
| Independence | removal runs: errors / coverage report | **6 runs (2 per technology) + 1 mixed, 0 error logs** | without Contacts / without Todos per technology; mixed shell without the Svelte Contacts feature → `unrendered contacts:list`, no error |
| Composability | interactions (1)–(3) pass | **3/3 under Svelte, Solid, Vue**, and (1), (2) in the mixed Solid+Svelte shell | |
| Composability | files changed in Contacts for interaction (1) | **0** | P0's logic, unchanged |
| Composability | second UI technology: logic files changed / new UI LOC | **Svelte 0 / 497 · Solid 0 / 570 · Vue 0 / 624** | Svelte: binding 16 (kit 46), API 7, renderers 227 (todos 116, contacts 92, hello 19), host 217. Solid: binding 8 (kit 33), API 7, renderers 244 (122 / 102 / 20), host 286. Vue: binding 12 (kit 65), API 7, renderers 264 (132 / 109 / 23), host 288. P0: React renderers 224, DOM 791 (incl. 106 test shell). Bridge Svelte→Solid 36 |
| Correctness gate | contract · commit races · dispose · late subscriber · read-then-set | **green for the logic (P0's suites; the bytes are identical)**; binding probe green ×3 | probe: 1 subscribe per mounted group, balanced unsubscribe on withdrawal, 0 DOM mutations and (stable snapshot) 0 template reads for 10 no-op notifications, 1 read per real change, in all three |

Totals: node 67 tests (identity 48, boundaries 19). Chromium 52 tests: workbench 3 × 11 plus mixed 4,
standalone 6, flush 3, binding probe 6. LOC (non-test): UI 1562 (three technologies plus the bridge),
kits for technologies 144, API extension points 21, apps/features/main 250. Tests 983, including P0's
copied driver and boundary graph.

### The binding probe (`tests/e2e/binding.test.ts`)

A hand-rolled `ContactDetailsView` whose snapshot counts property reads, rendered by each technology's
real `contacts:details` renderer. The model sends 10 notifications with no change, then 1 real change.

| | subs | reads at mount | reads per 10 no-op | template field reads per 10 no-op: stable / fresh snapshot | DOM mutations | unsubscribed on withdrawal |
| --- | --- | --- | --- | --- | --- | --- |
| Svelte | 1 | 1 | 10 | **0** / 40 (40 / 40 before the adapter's identity check) | 0 | yes |
| Solid | 1 | 2 | 10 | **0** / 40 | 0 | yes |
| Vue | 1 | 2 | 10 | **0** / 40 | 0 | yes |

A point-7 violation (a fresh snapshot on every read) wastes work in all three but breaks none of them.
Every one writes the DOM only on real text changes. In React the same violation is an infinite render
loop. So the severity of the same contract breach depends on the framework, as R0 predicted.

## Answers to the points to clarify

- **Which contract points did each binding rely on, and did any technology need an extra guarantee?**
  Svelte relies on point 1 (it is the store contract), point 4 (synchronous, in order) and point 7
  (the identity check in the adapter). Solid and Vue rely on point 7 (signal `===` / `shallowRef`
  `Object.is`) and point 4. For them point 1 only makes the initial read redundant. All three rely on
  the returned unsubscribe for teardown (the probe checks it is called once per subscription);
  points 5, 6 and 8 were not exercised by any binding. No
  technology needed a new *model* guarantee. The one extra rule is on the **host**: if a
  contribution's model can be replaced under the same id, setup-once technologies (Solid, Vue) must
  re-create the renderer, so the host keys it by model identity.
- **Was the renderer contribution type (`shell/api/<tech>`) natural for Svelte/Solid components?**
  Yes. `{ kind, component: Component<{ model: M }> }` is the native component type in all three
  (a Svelte 5 component is a function, a Solid component is a function, a Vue component is an object).
  Each extension point is 7 LOC, a copy of React's with the import swapped. The only unnatural part is
  the carried-over existential cast. For interop, the lowest common denominator is P0's *DOM* renderer
  shape (`mount(host, model) → unmount`): the bridge rebuilds exactly that from Svelte's
  `mount`/`unmount`.
- **Where did each technology's reactivity fight the model contract?** There were no double
  subscriptions (the probe counts 1 per group in all three), and no stale snapshots after a real
  change (1 read and 1 update). Eager reads: Solid and Vue read twice at mount (the initial value plus
  the immediate callback), which is harmless. The conflicts were elsewhere:
  - Svelte's object inequality needed the adapter's identity check.
  - In Solid, a subscription made in a re-running JSX expression subscribes again, and `<For>` by
    reference re-creates panels.
  - Setup-once components need keyed hosts.
  - Svelte and Vue batch DOM writes after our synchronous notification, so tests need `flushSync` or
    `nextTick`. Solid does not batch them.
- **Is anything in P0's shell API secretly React-shaped?** The neutral `shell/api` is not. It has
  `getSnapshot` and `observe` for slots, models for header items, menu items and toasts, and
  `shellRoot: Element`, and every host read it through the same binding it uses for models. Two things
  come from React's behaviour rather than from the API. First, **controlled inputs**: P0's React
  renderers get "the model is the only writer of `checked`/`value`" for free, and the other three have
  to restore it by hand. Second, **re-subscribing when the model changes**: `useSyncExternalStore` does
  it, and setup-once technologies need the host to key by model. P0's React shell also used
  `flushSync` in its activator, which Svelte mirrors (`mount` + `flushSync`) and Solid and Vue do not
  need.

## Recommendation for consolidation

1. ADR-014 holds: **keep the model contract as the UI boundary**. Three more technologies needed
   0 logic changes, 8–16-line bindings and no new guarantee.
2. **State the host rules the definition leaves implicit.** A renderer is re-created when its
   contribution's model changes identity. Inputs are controlled: the model is the only writer of a
   field's rendered value.
3. **Name per-technology flush in the test guidance**: none (DOM, Solid), `flushSync()` (Svelte),
   `await nextTick()` (Vue), a scheduler commit (React). e2e scenarios should keep polling, which is
   why P0's ran unchanged.
4. **Give Svelte's binding the identity check**, and pin the probe (1 subscription, balanced
   unsubscribe, 0 work for a no-op with a stable snapshot) as a conformance test for any future
   binding.
5. **The shell host is the cost center (44–50% of each technology's UI: Svelte 217/497, Solid 286/570, Vue 288/624).** If several technologies
   must coexist, prefer **one host plus renderer-slot bridges** (36 LOC here) over one host per
   technology. Consider making P0's DOM renderer shape (`mount(host, model) → unmount`) the
   interoperability format that every technology can produce.
6. Fix P0's Ctrl-click selection arithmetic in the model (`toggleSelected(id)`). U1 copied it into
   three more renderers because it was not allowed to change the logic.
