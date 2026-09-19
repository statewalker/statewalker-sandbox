# J2 lessons — json-render as a renderer technology

**Status: DONE.** Every view kind of the benchmark is one json-render spec (7 JSON files, 8 kinds:
`todos:rename` reuses the editor's spec) rendered by React and by Solid over P0's logic (42/42 files
byte-identical) and over the unchanged P0 React host and U1 Solid host. All of P0's e2e scenarios
pass under both technologies; correctness holds — **but only because of a 126-LOC adapter that had
to be written carefully, and after three json-render behaviours were worked around.** On size,
"renderers as data" loses: for two technologies the json-render UI is about 1.7× the hand-written
one, plus ~21 KB gzip of runtime and ~26 KB gzip of Zod.

Tests: `pnpm test` 244 (node, 17 files), `pnpm test:browser` 48 (Chromium), stable over 3 runs;
`pnpm typecheck`, `pnpm build` green.

## Numbers

### UI LOC (non-blank, non-comment; `pnpm loc`)

| | J2 (json-render) | U1 Solid (hand-written) | P0 React (hand-written) |
| --- | --- | --- | --- |
| Views, **shared** by all technologies | specs 303 (JSON) + bindings & contribution 103 = **406** | — | — |
| Generic layer, **shared** | `@kit/jr` 242 (adapter 126, catalog definitions 82, bridge 25, functions 5) + `shell/api/jr` 9 = **251** | — | — |
| Per technology: renderers | `jr.react` **139** (catalog 89, view 31, bridge 19) · `jr.solid` **140** (98 / 23 / 19) | **244** + binding kit 33 + API 7 | **225** + kit 36 + API 7 |
| Per technology: shell host | P0's 280 / U1's 286, **reused, 0 new** — still needed | 286 | 280 |
| Two technologies, host excluded | 406 + 251 + 139 + 140 = **936** | 284 + 268 = **552** | |

- Per view, a spec + its binding is **1.6–1.9×** one hand-written renderer: Todos 217 vs 113
  (React) / 122 (Solid); Contacts 154 vs 92 / 102; hello 35 vs 20 / 20. A spec pays for itself only
  from the second technology on, and the 251-LOC generic layer never. Break-even for the whole UI is
  about **7 technologies** (shared 657 / ≈95 LOC saved per technology).
- Rename a todo: **1 line for every technology** (`todos.ui.jr/index.ts` registers the editor's spec
  and binding for `todos:rename`); U1: 1 line per technology.

### Bundle (`pnpm size`: one workbench's UI — shared views + `jr.<tech>` — minified, UI library external)

| | React | Solid |
| --- | --- | --- |
| Our UI code (json-render and zod external) | 22.3 KB min / 5.9 KB gz | 23.5 KB min / 6.3 KB gz |
| + json-render runtime | +73.7 KB min / **+21.2 KB gz** | +68.9 KB min / **+19.3 KB gz** |
| + zod (the catalog's prop schemas; P0 ships no zod at runtime) | +113.1 KB min / **+26.1 KB gz** | +113.1 KB min / **+26.1 KB gz** |

For scale, CONSOLIDATION rejected XState at 13.2 KB gzip.

### Binding probe through the adapter (U1's probe, `contacts:details` spec)

| | subscribes | reads at mount | 10 no-op notifications: reads / field reads / DOM mutations | one change: reads / field reads |
| --- | --- | --- | --- | --- |
| React, stable snapshots | 1 | 5 | 10 / **0** / 0 | 1 / 4 |
| Solid, stable snapshots | 1 | 5 | 10 / **0** / 0 | 1 / 4 |
| React / Solid, fresh snapshot per read (point 7 broken) | 1 | 5 | 10 / 40 / 0 | 1 / 4 |

Zero element work on a no-op: the adapter compares the group's snapshot identity and notifies no
json-render listener. The 10 reads are the adapter's own. (U1 plain Solid: 2 reads at mount.)

## What worked

- **0 logic files changed; 0 host files changed.** The identity test covers P0's 42 logic files and
  the 10 host files (P0's React host + kit + extension point, U1's Solid host + kit + extension
  point). P0's e2e scenarios ran verbatim: 22/22 under React and Solid on the first run except one
  (Solid focus return, see below).
- **One spec, two technologies.** No view file names a technology (R11); `jr.<tech>` is the only
  per-technology UI code besides the reused host. The shell host did not notice: a
  `ui.jr:views` → `ui.<tech>:renderers` bridge (`mirrorSlot`, 25 LOC) makes json-render views
  ordinary renderers, so coverage, removal and late arrival kept working (removing `jr.react`
  leaves every kind unrendered, 0 errors; the coverage report lists `ui.jr:views` as unobserved).
- **Single writer held through the adapter, with negative controls.** Every pointer of the
  `todos:list` and `contacts:editor` snapshots was written: only `/newTitle` and the three draft
  fields reach the model (as `setNewTitle` / `editField`); 20+ others are refused and the model is
  unchanged. In the browser, a spec binding `/count` (a presentation group) and emitting `setState`,
  `pushState` and `removeState` logs 4 refusals and writes nothing, under both technologies.
- **Commit time held through the spec.** json-render calls the handler synchronously inside the
  click (`emit` → `execute` → handler before any `await`), and our handlers are only `submit()`, so
  P0's capture-at-submit is untouched: typing in the same tick as Save/Rename is not committed; a
  double press in one tick is one commit (Rename, Save, Delete with a re-selection between); two Adds
  are two queued commits; a press while running hits a disabled button. P3's 15 races (adapted to
  P0's single-step Save) pass on the logic.
- **Specs cannot hide domain logic.** The one domain hit (P0's Ctrl-click arithmetic) moved into the
  shared binding: 1 copy instead of 1 per technology.
- **A spec is checkable data.** A conformance test resolves every `$state` / `$bindState` / `on`
  reference of each spec against its binding (reads exist, binds are form fields, invoked actions
  exist) — what type-checking is for code; its negative control binds `/outcome` and is caught.

## What failed or needed a workaround

1. **`@json-render/solid` ignores `repeat.key`.** Its `RepeatChildren` computes a key and never uses
   it; `<For>` keys rows by item identity. A toolbar entry that carried its `ActionState` was
   re-created whenever that action's state changed — the Clear-completed button was replaced while
   its dialog was open, and **focus return failed** (P0's dialog scenario, Solid only). Fix in the
   adapter: action lists expose identity-stable `ids` and a separate `states` map, and the spec
   looks each state up with `$computed: "at"` — a technology limitation leaking into the shared spec
   (3 buttons).
2. **Two derived keys = a torn snapshot.** The first version of that fix used two groups over one
   list; a listener saw new ids before the states (or, on removal, new states before the ids) and a
   `Button` rendered with `action: undefined`. json-render's per-element error boundary swallowed the
   throw (a `console.error` only; the button simply vanished). Fix: one group `{ ids, states }`.
   Lesson: everything a spec reads that comes from one model group must stay one snapshot key.
3. **Adapter re-entrancy.** With a model breaking contract point 7, the Solid provider recursed
   until the stack overflowed: `subscribe` added the listener, then refreshed the snapshot, which
   notified that same listener, which read the snapshot, which refreshed… (React was immune: it does
   not read synchronously in the listener). Fixed by refreshing before adding the listener and
   marking "subscribed" before subscribing to the groups. The adapter is the only enforcement point,
   and it is subtle code.
4. **`catalog.validate` does not validate props.** With more than one component, json-render's
   schema types `props` as `record<string, unknown>` (`core/src/schema.ts`, `case "propsOf"`): an
   unknown component type is rejected, a `Button` with `action: 5` is accepted. (Props usually hold
   expressions, which could not be validated statically anyway.)
5. **`@json-render/solid` cannot be imported under Node** (a client-only Solid API at module
   evaluation), so the node harness must never reach the Solid feature module — the features were
   split per technology.
6. **Controlled inputs in Solid.** A refused (or normalised) write leaves the model unchanged, so
   Solid does not re-render and the input keeps the typed text; the Solid catalog `TextInput` puts
   the model's value back itself (as U1's checkbox did). React re-asserts controlled values.
7. **Action lists in `on` are not one tick.** `emit` awaits each binding, so the checkbox's
   `[select, submit]` runs `submit` a microtask after `select` (P0's API says "one gesture, one
   tick"). Harmless here — the capture is at `submit`, nothing interleaves — but it is a sequential
   script in the view.
8. **`$item` means two things.** In props it is the item's value; in action params it is the
   item's **path** (`resolveActionParam`). Ids in params are therefore passed as `$template: "${id}"`.

## Pros

- One set of views for every technology json-render supports; a new view kind is written once.
- Views are data: no code path in a spec, a pinned expression vocabulary (R12), a mechanical
  conformance check against the binding, and domain logic has nowhere to hide.
- The architecture absorbed it with no kernel or contract change: one neutral extension point, a
  bridge bundle per technology, hosts untouched.
- The same catalog and specs are what J1's generated UIs would use (option (c)).

## Cons

- **More code, not less**, until ~7 technologies: JSON specs are verbose, and the adapter + catalog
  definitions are a fixed layer that hand-written renderers do not need.
- **The shell host (F7) is untouched**: 280/286 LOC per technology, still hand-written — json-render
  has no notion of panels, tabs, menus, dialogs or focus return; it only fills a panel's body.
- **Correctness lives in the adapter**: single writer by refusal, zero no-op work by identity
  comparison, snapshot atomicity by grouping, re-entrancy by ordering. Every one of those broke once
  during this spike.
- **Technology behaviour still differs under the "shared" views**: Solid's repeat identity and
  controlled inputs needed catalog/adapter work that React did not.
- **Dependency weight and churn**: +21 KB gzip runtime, +26 KB gzip Zod, a 0.x Labs library with
  breaking minors; per provider stack a confirmation-dialog manager, a validation provider and an
  action provider we do not use.
- **Concepts**: +9 (spec, catalog, catalog implementation, expression language, `on`/`emit` +
  handlers, providers, model binding, refusal, views → renderers bridge) and +7 rules (no built-ins;
  `$item` path vs value; Solid catalog reads `c.props` lazily; repeated items identity-stable; one
  group per source; Solid inputs restore the model value; `@json-render/solid` not in Node).

## Answers to the points to clarify

- **Does an unchanged shell host reveal json-render's missing surface or lifecycle concept?** The
  host files are untouched and every host feature works (tabs, menu, dialog stack, focus return,
  toasts, coverage). But the host's focus return depends on the renderer keeping DOM identity across
  a model change, and json-render's Solid renderer did not (repeat keys ignored) until the adapter
  compensated. json-render has no surface/lifecycle concept of its own to conflict with; its one
  (the `confirm` dialog of an action binding) is unused, and must stay unused — it would be a second
  dialog stack beside `shell:dialogs`.
- **Is `visible`/`$cond` in specs view logic like `if (!contact)` in a renderer?** Yes, one for one:
  4 `visible` conditions, 1 `$cond` (current row), 1 `$computed includes` (selected rows) replace
  exactly the conditionals of P0's renderers. They are counted as view logic, not domain logic; the
  expression vocabulary is pinned by R12 so a new kind of logic in a spec is a visible decision.

## Recommendation for consolidation

1. **Do not adopt json-render as the renderer technology for hand-written views.** It does not cut
   per-technology UI cost at two technologies (936 vs 552 LOC), does not touch the host, adds
   ~47 KB gzip, and its correctness depends entirely on an adapter that is subtle.
2. If json-render is used at all (J1's generated UIs), keep this spike's rules: a schema without
   built-ins; a store adapter that refuses every path but declared form fields; one snapshot key
   per model group; identity-stable repeated items; handlers that only `submit()` or call intents;
   no `onSuccess`/`onError`/`watch`/`validateForm`/`confirm` in specs.
3. Keep "a technology-neutral view contribution + a per-technology bridge into the renderer slot"
   as the pattern if a data-driven view format is ever adopted — it needed no kernel or host change.
4. Compare with J3: if an in-house schema whose bindings name model groups and intents reaches J2's
   correctness with no adapter, the adapter's four failure modes above are the argument for it.
