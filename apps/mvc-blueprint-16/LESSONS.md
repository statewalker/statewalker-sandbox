# J3 — lessons (mvc-blueprint-16)

**Status: DONE.** Branch `spike/j3-inhouse-schema`. Every view kind of the benchmark is one JSON spec,
rendered by a plain-DOM and a Solid interpreter over P0's logic, unchanged. The question: is
json-render's value for *hand-written* views anything that 300–600 LOC of our own would not give,
with single writer held by the grammar instead of by an adapter?

**Short answer: no, for hand-written views json-render adds nothing J3 lacks, and J3 is small
(524 LOC of machinery for two technologies, 2.4–2.7 KB gzip). But "renderers as data" does not pay
for itself at two technologies either.** The specs are about as long as one technology's
hand-written renderers, so a second technology costs 831 UI LOC instead of 548. It breaks even at
about four technologies, and the shell host, the real per-technology cost, is untouched.

Tests: `pnpm test` 234 (node), `pnpm test:browser` 40 (Chromium), `pnpm typecheck` clean (it
includes the type-level name checks of every spec).

## What worked

- **0 logic files changed.** The 42 P0 logic files and P0's e2e driver are byte-identical, and so
  is every reused UI file: P0's DOM kit, DOM host, test shell and DOM renderer API, and U1's Solid
  kit, Solid host and Solid renderer API (`tests/identity`, 59 tests). J3 replaces only the
  renderers.
- **P0's e2e scenarios passed verbatim, on the first run, under both interpreters.** They cover
  (1)–(3), Todos, Contacts with the failing save, Rename, hello, focus return, coverage and the
  removal runs: 11 × 2. The standalone runs pass in the trivial test shell through the DOM
  interpreter.
- **Single writer holds by grammar, and it is checked three ways.**
  - Type level: specs are typed `ViewSpec<M>`. `IntentName<M>` is the model's functions minus
    `get*`/`on*Update`, `ActionName<M>` is its `ActionView` members, and `GroupName<M>` is its
    `getX` names. `intent: "getDraft"`, `intent: "onItemsUpdate"`, `read: "itemz"`,
    `action: "draft"` and `{ set: "draft.title" }` all fail `tsc` (6 `@ts-expect-error` controls).
  - Runtime: `validate(spec, model)` runs at mount and throws a `SpecError` naming the node. There
    are 13 negative controls, including json-render's `setState`, `$bindState`-style two-way
    binding and `watch`.
  - Code: boundary rule R12 finds exactly two model-member call sites in the whole UI layer (a group
    getter, a named intent), no assignment into a model, and no path-store API.
- **Through the interpreters (browser).** Every spec is mounted by each interpreter over a real
  view facet that records its calls, and every element receives every event. Only `select`,
  `setNewTitle`, `editField` and action `submit`s reach the model. The negative control is a facet
  that carries a presentation writer: the check catches it.
- **Commit time needed nothing.** The grammar's only action write is `submit()`, so capture stays in
  P0's controllers. There is no `onSuccess`/`onError`/`watch`, so outcomes stay owner state. The
  browser suite runs these through the UI under both interpreters:
  - press Save, type, press Save and Enter, all in one tick: one api call, carrying the value at
    the press;
  - the button then shows `aria-busy`;
  - a double checkbox press toggles once;
  - three queued Adds make three todos in order.
  P0's 9 commit races stay green, headless.
- **U1's binding probe through the interpreters** (the real `contacts:details` spec):

  | | subscribes | reads at mount | DOM mutations per 10 no-op notifications | field reads per 10 no-ops (stable / unstable snapshot) | reads per change |
  | --- | --- | --- | --- | --- | --- |
  | DOM | 1 | 1 | 0 | 0 / 40 | 1 |
  | Solid | 1 | 2 | 0 | 0 / 40 | 1 |

  These are U1's numbers. The DOM interpreter dedupes by `===` per group and writes the DOM only
  when a value differs.
- **Technology rules are written once, in the interpreter, instead of in every renderer.**
  - In U1 these were per-renderer rules: subscribe in setup, never inside JSX; `<For>` keyed by
    reference; controlled inputs; re-create the renderer on a model-identity change (handled by
    the hosts, unchanged). The Solid interpreter now implements the first three once.
  - The DOM interpreter makes `value` and `checked` controlled for every spec. P0's hand-written
    DOM checkbox was not controlled.
- **Small, and our own.** The neutral kit is 172 LOC, the DOM interpreter 172, the Solid
  interpreter 111 and the schema API 69: 524 LOC for two technologies, with no dependency. The
  gzip sizes are 1.7 KB for the neutral kit, 2.7 KB for DOM (with the neutral kit and P0's DOM kit)
  and 2.4 KB for Solid (solid-js external). json-render costs about 20 KB gzip plus Zod (92 KB), and
  about 3k LOC per technology that we would not own.
- **Composability.** Specs are contributions to the keyed slot `ui:specs`, and each interpreter
  mirrors them into its renderer slot. Removing an app removes its views in every technology. A new
  view kind is one spec for all technologies.

## What failed (or cost more than expected)

- **Specs are not shorter than code.** The spec data for 8 kinds (7 specs) is 259 LOC and 8.2 KB.
  U1's Solid renderers are 244 LOC including wiring (6.9 KB), and P0's DOM renderers are 304.
  Formatted JSON trees are longer than JSX: every attribute is a key, and every binding is an
  object. Spec wiring adds 48 LOC.
- **Break-even is about four technologies.** Counting UI without hosts and without the reused
  binding kits:

  | | 1 technology | 2 technologies | each further technology |
  | --- | --- | --- | --- |
  | hand-written (P0 DOM, U1 Solid) | 244–304 | 548 | 244–304 |
  | J3 | 548 (shared) + 111–172 | 831 | 111–172 |

- **The shell host is untouched**, by design: 286 LOC for Solid and 304 for DOM, which is the
  largest share of every technology (F7). Neither J3 nor J2 addresses it.
- **The grammar needed more than a generic UI vocabulary.** The benchmark needed:
  - event data (`value`, `checked`, and `extend` for Ctrl/Meta);
  - list membership (`toggle`, `includes`);
  - handler lists (`select` then `toggle.submit()` in one tick);
  - controlled `value`/`checked`;
  - a `submit` that does not navigate;
  - an `actions` node for the app's own action extension points, which controllers fold into
    models (P0 amendment 7);
  - constant groups: `ConfirmView.getQuestion` has no subscriber.

  Each of these is a small language feature. The expression language is a second place for view
  logic: the Ctrl-click policy is `if: [event.extend, toggle(selection, item.id), [item.id]]`.
- **Type holes.**
  - Only the first segment of a path is checked: `read: "draft.titel"` compiles and validates, and
    renders empty.
  - `{ item: "titel" }` is unchecked, because the item type is not threaded through `each`.
  - Fixing either needs the snapshot types in the grammar (a deeper generic). J2 has the same hole
    with JSON Pointers.
- **The single-writer guarantee is only as good as the facet.** Handed an object with a
  presentation writer, a spec that names it validates and writes (the negative control shows it).
  The grammar forbids path writes and makes every write a named call. What stays out of reach is
  decided by P0's frozen view facets, exactly as for hand-written renderers. J3 adds no weaker
  point, and no stronger one.
- **Tooling friction.**
  - Biome's `noThenProperty` forbade `{ if, then, else }`, so the grammar uses a tuple
    `if: [c, then, else?]`.
  - `.json` spec files would lose the type-level name check (JSON imports widen literals), so
    specs are TS modules that hold JSON literals. R1 and a round-trip test prove they are data.
  - U1's `shell.solid/host.tsx` has one inherited Biome `organizeImports` finding. It is left
    as-is to keep it byte-identical.

## Pros

- Single writer and commit time hold **by construction**: the grammar has no path write, no
  execution and no outcome handling. json-render needs a refusing adapter for the same guarantees
  (research §3).
- One spec serves every technology, including plain DOM, which json-render lacks.
- Views cannot hide domain logic in code. The one domain hit is visible and shared (1, against
  U1's 3 and P0's 2).
- Technology correctness rules are implemented once per technology, not once per renderer.
- Small, dependency-free, and checked by `tsc`.

## Cons

- More LOC than hand-written renderers until about four technologies. Specs read worse than
  JSX/DOM code for anyone who knows the technology.
- A new mini-language to learn: 7 nodes, 8 operators, 2 writes, 3 rules. It grows with every
  interaction pattern: drag, keyboard shortcuts and focus management are not expressible yet.
- The per-technology cost centre (the shell host) is unchanged.
- The type check stops at the first path segment and at `each` items.

## Fitness table

| Axis | Measurement | J3 | U1 / P0 for comparison |
| --- | --- | --- | --- |
| Simplicity | concepts | 26 (P0) + 4 structural (view spec, `ui:specs`, interpreter per technology, binding by name) + grammar (7 nodes, 8 operators, 2 writes, 3 rules); **0 per additional technology for view authors** | U1: 26 + 3 per technology + technology rules |
| Simplicity | schema size | 20 constructs + 10 tags + 4 events | json-render: about 30+ (spec, catalog, registry, providers, 7 expression forms, 6 built-ins, `watch`, `checks`, `onSuccess`/`onError`, …) |
| Simplicity | `hello` UI | spec 12 + wiring 13 = 25 LOC, 2 files, for every technology | Solid 20, DOM 20 (each) |
| Simplicity | Rename a todo, UI | 1 line (`todoRenameKind` → `titleFormSpec`), once | 1 line per technology |
| Separation | boundary rules / violations | **12 / 0** (P0 R1–R8 adapted, R9 no cross-technology import, R11 shared half imports no technology, R12 no generic setter), a negative control each | U1 10 / 0 |
| Separation | single-writer violations | **0**: grammar (tsc + validator, 19 negative controls) + 16 mounts × every event in the browser | 0 |
| Separation | domain-logic hits in views | **1** (Ctrl-click toggle, in the shared spec) | U1 3 (1 per technology), P0 2 |
| Independence | cross-bundle edges / violations | 0 violations (graph report) | 0 |
| Independence | standalone runs | pass / pass (test shell + DOM interpreter); headless pass / pass | pass |
| Independence | removal runs | 4 headless + 2 per technology in the browser, 0 errors | 0 errors |
| Composability | interactions (1)–(3) | **3/3 × DOM, Solid** | 3/3 × 3 |
| Composability | UI LOC: shared | specs 259 + wiring 48 + schema API 69 + neutral kit 172 = **548** | — |
| Composability | UI LOC: per technology (interpreter) | **DOM 172 (kit 156 + bundle 16), Solid 111 (kit 95 + bundle 16)**; ≤ 400 even with the neutral kit (344 / 283) | renderers: P0 DOM 304, U1 Solid 244 |
| Composability | UI LOC, two technologies, hosts excluded | **831** | 548 |
| Composability | reused per technology, unchanged | host (DOM 304, Solid 286) + binding kit (DOM 78, Solid 33) + renderer API (6 / 7) | same |
| Composability | logic files changed | **0** (42/42 byte-identical) | 0 |
| Composability | KB gzip of the machinery | neutral 1.7; DOM 2.7 (incl. neutral + P0 DOM kit); Solid 2.4 (incl. neutral + U1 kit) | json-render about 20 + Zod 92 |
| Correctness gate | contract · commit races · dispose · late · read-then-set | **green** (P0's suites over identical bytes: 83 + 7 + 4, 9 commit races, 4, 3, 7) + 6 UI-level commit races + binding probe × 2 | green |

## Answers to the points to clarify

- **How big must the schema be, and what did the benchmark need beyond a generic vocabulary?**
  - The benchmark needed 20 constructs: 7 nodes, 8 operators, 2 writes and 3 rules, plus 10 tags
    and 4 events.
  - Beyond a generic vocabulary it needed: Ctrl-click (`event.extend`, `toggle`); the row checkbox
    (a handler list `select` then `submit: toggle`, plus controlled `checked`); forms (`submit`
    without navigation); the app's action extension points (the `actions` node); and constant
    groups.
- **Is `if`/`when` in a spec view logic?** Yes, the same kind as `if (!contact)` in a renderer.
  - There are 4 `when` (outcome, form error ×2, contact) and 3 `if` (aria-current ×2, the done
    class).
  - The Ctrl-click `if`/`toggle` is policy: it counts as the one domain hit. The real fix is still
    a `toggleSelected(id)` intent in the list model (U1 recommendation 6), which would shrink the
    spec to `{ intent: "toggleSelected", args: [{ item: "id" }] }` and remove `toggle` and
    `extend` from the grammar.
- **How are single writer and commit time enforced?**
  - Single writer, by the grammar: there is no path write, and a write names an intent or an
    action, checked by tsc and by the validator.
  - By the models: P0's frozen view facets hold no presentation writer.
  - By the interpreter code: R12, two call sites.
  - Commit time is the models' and controllers' alone. The interpreter only calls `submit()`,
    evaluates intent arguments at the gesture, runs a handler list in one tick, and never queues,
    retries or awaits.
- **Does an unchanged shell host miss anything?** No. Both hosts are byte-identical to P0 and U1.
  Focus return, dialogs, tabs and coverage all work. Interpreters are ordinary renderers
  (`mount(host, model)` and a `Component<{ model }>`). The Solid host already re-creates a renderer
  on a model-identity change, so the interpreter needs no keying.

## Recommendation for consolidation

1. **Do not adopt json-render as a renderer technology for hand-written views.** J3 gives
   everything it gives there in 524 LOC and 2.4–2.7 KB. It holds single writer by grammar, not by
   a refusing adapter, and it also covers plain DOM. json-render's remaining value is generative:
   catalog → prompt, streaming, validation of untrusted specs. That is J1's role (option d).
2. **Do not adopt "renderers as data" for hand-written views either**, at the current count of
   technologies (1–2). Hand-written renderers are shorter and more readable until about four
   technologies. The cost centre is the shell host, which no schema touches.
3. **Keep J3's schema as the documented fallback.** If the number of UI technologies grows, or
   specs must cross a realm boundary (option e), J3's grammar is the minimal wire format that keeps
   MODELS §2: groups and intents by name, no generic setter.
4. **Adopt two lessons whatever the choice:**
   - Implement a technology's correctness rules (controlled inputs, subscribe once in setup, keyed
     iteration) in one shared helper per technology, not per renderer. This is the part of J3 that
     paid for itself.
   - Move Ctrl-click selection into the model (`toggleSelected(id)`). U1 recommended it, and J3
     shows it would also delete two grammar constructs.
