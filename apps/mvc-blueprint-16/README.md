# @statewalker/mvc-blueprint-16 — prototype **J3**

**J3 — control for J2: a minimal in-house JSON view schema.** The benchmark (shell + Todos +
Contacts + the three cross-app interactions + standalone runs) with **no hand-written renderer**.
Every view kind is one technology-neutral JSON **spec**. A spec binds the kind's view model **by
name**: reads name a model group (`getX`/`onXUpdate`), writes name an intent of the view facet
(`select`, `setNewTitle`, `editField`) or an action (`ActionView.submit`). One **interpreter** per
technology (plain DOM and Solid) turns specs into renderers. P0's logic is unchanged, byte for byte,
and so are the shell hosts (P0's DOM host, U1's Solid host).

- Brief (with the lessons section): umbrella repository,
  [`docs/sandbox-apps/architecture/prototypes/J3.md`](../../../../../docs/sandbox-apps/architecture/prototypes/J3.md)
  (`statewalker/umbrella`, path `docs/sandbox-apps/architecture/prototypes/J3.md`). It is derived
  from `docs/sandbox-apps/architecture/research/json-render.md` §5.
- The logic it reuses: P0's [`README.md`](../mvc-blueprint-04/README.md); the Solid host and binding:
  U1's [`README.md`](../mvc-blueprint-08/README.md).
- Full lessons and fitness numbers: [`LESSONS.md`](LESSONS.md).

```
pnpm dev             # http://localhost:5173/?app=workbench.dom | workbench.solid
                     #   | todos.standalone | contacts.standalone
pnpm test            # node: identity proof, P0's correctness gate, spec grammar + negative controls,
                     #   boundary suite (R1–R12) + graph report
pnpm test:browser    # Chromium: P0's e2e scenarios per interpreter, standalone runs, commit races
                     #   through the UI, single writer through the UI, binding probe, flush
pnpm typecheck       # tsc — includes the type-level name checks of every spec
pnpm build
pnpm loc [prefix…]   # LOC per module (non-blank, non-comment)
```

## Layout

```
src/kernel/  src/kits/{signals,model,loop,slots,notify,host}/   P0, byte-identical
src/bundles/<every logic bundle and API module>/               P0, byte-identical
src/features/logic.ts                                           P0, byte-identical
src/kits/dom/  src/bundles/shell.dom/  shell.test/  shell/api/dom/      P0, byte-identical (reused UI)
src/kits/solid/  src/bundles/shell.solid/  shell/api/solid/             U1, byte-identical (reused UI)

src/bundles/shell/api/spec/      THE schema: types (names checked against the model type) + `ui:specs`
src/kits/spec/                   neutral half: validate, groupsOf, evaluate, dispatch, mirror (no DOM)
src/kits/spec-dom/               the plain-DOM interpreter: mountSpec(spec, host, model)
src/kits/spec-solid/             the Solid interpreter: specComponent(spec)
src/bundles/ui.dom.spec/         mirrors `ui:specs` into `ui.dom:renderers`
src/bundles/ui.solid.spec/       mirrors `ui:specs` into `ui.solid:renderers`
src/bundles/{todos,contacts,hello}.ui.spec/   the specs (data) and their contribution
src/features/ui.ts               spec features (one per app, shared by every technology)
src/features/tech.ts             a technology = shell host + interpreter
src/apps/workbenches.ts          workbench per technology, standalone runs (test shell + DOM interpreter)
```

## The schema

| | Constructs |
| --- | --- |
| Nodes (7) | `"text"` · `{ text }` · `{ el, attrs?, on?, children? }` · `{ each, children }` · `{ when, children }` · `{ action }` · `{ actions, label }` |
| Expressions (8 + literals) | `{ read: "group.field" }` · `{ item: "field" }` · `{ event: "value"\|"checked"\|"extend" }` · `concat` · `eq` · `includes` · `toggle` · `if: [c, then, else?]`; strings, numbers, booleans, `null`, arrays |
| Writes (2) | `{ intent, args? }` (a view-facet mutator) · `{ submit }` (an action) |
| Rules (3) | `value`/`checked` are controlled (reset to the model after a handler); handlers of one event run in order in one tick; `submit` never navigates |
| Vocabulary | tags `div p span ul li form input dl dt dd`; events `click input change submit` |

There is **no path write, no generic setter, no watcher, no built-in action and no
`onSuccess`/`onError`**. Names are checked three times: by `tsc` (a spec is typed
`ViewSpec<TodoListView>`, so `intent: "setNewTitel"` or `read: "itemz"` does not compile), by
`validate(spec, model)` at mount (a `SpecError` names the node), and by the boundary rule R12 (the UI
layer calls model members in exactly two places: a group getter and a named intent).

## Choices

- Specs live in `*.ui.spec` bundles and are contributed to the keyed slot `ui:specs`; each
  interpreter bundle mirrors that slot into its technology's renderer slot. Removing an app removes
  its specs, and so its renderers in every technology; the hosts need no change.
- Specs are TypeScript modules holding JSON literals (`ViewSpec<M>`-typed), not `.json` files: `.json`
  imports widen names to `string` and lose the type-level check. A test proves each spec survives a
  JSON round trip, and R1 proves the files hold no code.
- The headless test shell checks coverage against `ui:specs` (every published kind has a spec).
- `when`/`if` are allowed (view logic of the same kind as a renderer's `if (!contact)`). The
  Ctrl-click selection policy is the one domain hit, written once in the shared list spec.
- Concepts a newcomer learns: P0's 26, plus 4 structural (a view spec, `ui:specs`, an interpreter
  per technology, binding by name), plus the grammar above.
