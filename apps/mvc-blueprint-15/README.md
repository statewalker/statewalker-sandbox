# @statewalker/mvc-blueprint-15 — prototype **J2**

**J2 — json-render as a renderer technology.** The benchmark (shell + Todos + Contacts + the three
cross-app interactions + standalone runs) where every view kind is **one json-render spec**, rendered
by **React and Solid** over P0's logic bundles (`apps/mvc-blueprint-04`), **unchanged**, through a
store adapter that is the single write path into the models. It measures "renderers as data"
against U1's hand-written renderers.

- Brief (with the lessons section): umbrella repository,
  `docs/sandbox-apps/architecture/prototypes/J2.md` (`statewalker/umbrella`); the research it
  comes from: `docs/sandbox-apps/architecture/research/json-render.md` (option (a) + (c)).
- The logic it reuses: P0's [`README.md`](../mvc-blueprint-04/README.md); the hosts it reuses: P0's
  React host and U1's Solid host ([`../mvc-blueprint-08`](../mvc-blueprint-08/README.md)).
- Full lessons and fitness numbers: [`LESSONS.md`](LESSONS.md).

```
pnpm dev             # http://localhost:5173/?app=workbench.react | workbench.solid
                     #   | todos.standalone.<tech> | contacts.standalone.<tech>
pnpm test            # node: byte-identity (logic + hosts), boundaries (R1–R12), P0's suites through
                     #   the json-render views, P3's 15 races, the adapter's single-writer suite,
                     #   spec ↔ catalog ↔ binding conformance, removal of the json-render layers
pnpm test:browser    # Chromium: P0's e2e scenarios × React, Solid; standalone; flush; U1's binding
                     #   probe through the adapter; negative controls; commit time and double press
                     #   through the spec
pnpm typecheck       # tsc (React and Solid .tsx in one project: Solid files carry a JSX pragma)
pnpm build
pnpm loc [prefix…]   # LOC per module (non-blank, non-comment; .ts, .tsx, .json)
pnpm size            # what json-render (and zod) add to each technology's UI bundle
```

## How it is put together

```
src/kernel/ src/kits/{signals,model,loop,slots,notify,host}/    P0, byte-identical
src/bundles/<every logic bundle and API module>/                P0, byte-identical
src/features/logic.ts                                           P0, byte-identical
src/kits/react, shell.react, shell/api/react                    P0's React host, byte-identical
src/kits/solid, shell.solid, shell/api/solid                    U1's Solid host, + a JSX pragma line

src/kits/jr/            technology-neutral json-render kit: the catalog (Zod definitions, a schema
                        without built-in actions), modelStore (THE adapter), $computed functions,
                        mirrorSlot (the views → renderers bridge)
src/bundles/shell/api/jr/        `ui.jr:views`: { kind, spec, bind(model) → ModelBinding }
src/bundles/{todos,contacts,hello}.ui.jr/   the views, ONCE for every technology: *.json specs +
                                            bindings.ts (what each spec reads, writes, invokes)
src/bundles/jr.react/, jr.solid/            one per technology: the catalog implementation
                                            (catalog.tsx), the providers around a spec (view.tsx),
                                            and the bridge ui.jr:views → ui.<tech>:renderers
src/features/{jr,react,solid}.ts            UI feature manifests (solid.ts apart: see below)
```

A shell host sees ordinary renderers: `jr.<tech>` mirrors every `ui.jr:views` entry into its
technology's renderer slot as a component that builds `modelStore(view.bind(model))` and renders
`<JSONUIProvider store handlers functions><Renderer spec registry/></JSONUIProvider>`.

## The adapter (`@kit/jr` `modelStore`)

A `ModelBinding` names, per view kind, what the spec may see and do:

| Binding field | In the json-render state | How the spec uses it |
| --- | --- | --- |
| `values: { key: [getX, onXUpdate] }` | `/key` = the group's snapshot | `$state`, `repeat`, `visible` |
| `actions: { key: ActionView }` | `/key` = its `ActionState` | `Button { action: {$state:"/key"} }`, `on.press: submit {ref:"key"}` |
| `actionLists: { key: [getX, onXUpdate] }` | `/key` = `{ ids: [{id}], states: {id: ActionState} }` | `repeat /key/ids`; `$computed at`; `submit {ref:"key/<id>"}` |
| `writes: { "/ptr": v => model.intent(v) }` | — | `$bindState: "/ptr"` |
| `intents: { name: params => … }` | — | `on.<event>: { action: "name", params }` |

`set(path)` / `update()` reach a model only through `writes`; everything else — presentation
groups, action states, the built-ins `setState`/`pushState`/`removeState` — is **refused**: an
error is logged and nothing is written (an `update` is refused whole). The snapshot is rebuilt only
for the group that changed, only when its identity changed: a no-op notification reaches no
json-render listener.

## Choices

| # | Question | Choice |
| --- | --- | --- |
| 1 | Import or copy P0/U1 | Copy + byte-compare test (as U1). Hosts compared too (Solid: minus one pragma line). |
| 2 | Catalog schema | Our own `defineSchema` (json-render's flat element tree) **without** `builtInActions`; no catalog actions (what a spec may invoke is per view, in its binding). |
| 3 | Specs as `.json` or TS objects | `.json`: they are data, and R12 checks they contain only the grammar. |
| 4 | Where the per-kind glue lives | `*.ui.jr/bindings.ts`, technology-neutral; P0's Ctrl-click arithmetic moved there (1 copy instead of 1 per technology). |
| 5 | Ctrl-click | Two catalog events on `Item`: `press` → `select`, `togglePress` → `toggleSelect`. |
| 6 | Checkbox gesture | An action list in the spec: `[select {id}, submit {ref:"toggle"}]`. |
| 7 | A refused write | Logged as an error and dropped (loud in tests via the recording logger; no throw inside the renderer). |
| 8 | Action lists | `ids` and `states` apart (Solid ignores `repeat.key`), but ONE group (no torn snapshot). |
| 9 | React and Solid in one Vite build | Solid's plugin owns `.tsx` under folders named `solid`/`*.solid`; React's the rest. |

## Dependencies added (exact pins)

`@json-render/core` 0.21.0, `@json-render/react` 0.21.0, `@json-render/solid` 0.21.0 (core
brings `zod`; the app's `zod` 4.5.4 satisfies it — one copy in the lockfile). `react`/`react-dom`
from the catalog, `solid-js` 1.9.15; dev: `vite-plugin-solid` 2.11.14, `@vitejs/plugin-react`.
