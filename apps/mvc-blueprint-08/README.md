# @statewalker/mvc-blueprint-08 — prototype **U1**

**U1 — other UI technologies over P0's logic.** The benchmark (shell + Todos + Contacts + the three
cross-app interactions + standalone runs) rendered by **Svelte 5, Solid and Vue 3** over the logic
bundles of P0 (`apps/mvc-blueprint-04`), **unchanged**. Only renderers, a thin binding and a shell
host per technology are new. It checks ADR-014 (a replaceable UI layer).

- Brief (with the lessons section): umbrella repository,
  [`docs/sandbox-apps/architecture/prototypes/U1.md`](../../../../../docs/sandbox-apps/architecture/prototypes/U1.md)
  (`statewalker/umbrella`, path `docs/sandbox-apps/architecture/prototypes/U1.md`).
- The logic it reuses, and the definition that logic implements: P0's
  [`README.md`](../mvc-blueprint-04/README.md) and [`LESSONS.md`](../mvc-blueprint-04/LESSONS.md).
- Full lessons and fitness numbers: [`LESSONS.md`](LESSONS.md).

```
pnpm dev             # http://localhost:5173/?app=workbench.svelte | workbench.solid | workbench.vue
                     #   | workbench.solid+svelte | todos.standalone.<tech> | contacts.standalone.<tech>
pnpm test            # node: the byte-identity proof against P0, the boundary suite (+ graph report)
pnpm test:browser    # Chromium: P0's e2e scenarios per technology, standalone runs, the mixed shell,
                     #   flush per technology, the binding probe
pnpm typecheck       # tsc (TS, TSX) + svelte-check (.svelte)
pnpm build
pnpm loc [prefix…]   # LOC per module (non-blank, non-comment; .ts, .tsx, .svelte)
```

## How P0's logic is consumed

The sandbox's apps are not packages of each other and P0 has no exports, so the logic is **copied**,
and `tests/identity/identity.test.ts` proves the copies are P0's bytes: it derives the logic set from
P0's tree **by rule** (everything under `src/kernel`, `src/kits`, `src/bundles` and
`src/features/logic.ts` except React/DOM kits, `*.ui.*` renderers, the `shell.react|dom|test` hosts
and the `shell/api/react|dom` extension points), asserts it is 42 files, and compares SHA-256 per file
(plus P0's e2e driver `tests/e2e/dom.ts`, `tests/e2e/scenarios.ts` and `tests/support/logging.ts`).
A file P0 adds later is covered automatically. `aliases.ts` and `scripts/loc.mjs` came from P0 too
(the latter extended for `.svelte`).

## Layout

```
src/kernel/  src/kits/{signals,model,loop,slots,notify,host}/   P0, byte-identical
src/bundles/<every logic bundle and API module>/               P0, byte-identical
src/features/logic.ts                                           P0, byte-identical

src/bundles/shell/api/{svelte,solid,vue}/   the renderer extension point per technology (7 LOC each)
src/kits/svelte/      modelStore (THE binding) + ActionButton/ActionBar components
src/kits/solid/       useModel (THE binding) + ActionButton/ActionBar
src/kits/vue/         useModel (THE binding) + identityKey, modelProp, ActionButton/ActionBar
src/bundles/shell.{svelte,solid,vue}/        the three shell hosts (provide shell:coverage)
src/bundles/{todos,contacts,hello}.ui.{svelte,solid,vue}/   renderers for every view kind
src/bundles/bridge.svelte-in-solid/          Svelte renderers become Solid renderers (mixed shell)
src/features/{svelte,solid,vue}.ts           UI feature manifests
src/apps/workbenches.ts                      workbench / standalone manifests per technology, mixed workbench
tests/identity/     the zero-change proof      tests/boundaries/  P0's suite + R9, R10
tests/e2e/          workbench, standalone, flush, binding probe (dom.ts, scenarios.ts: P0's)
```

## The three bindings

| | Binding | What the contract gives it | Flush for tests |
| --- | --- | --- | --- |
| Svelte | `modelStore(read, subscribe)` → a Svelte store; components use `$derived(modelStore(…))` and `$x` | point 1 **is** Svelte's store contract (no initial read); an identity check in the adapter (point 7), because Svelte treats every emitted object as changed | `flushSync()` |
| Solid | `useModel(read, subscribe)` → an accessor over `createSignal` (default `===`) | point 7 makes a no-op notification free; point 1 makes the initial read redundant | none: Solid writes the DOM inside our notification |
| Vue | `useModel(read, subscribe)` → a `shallowRef` | point 7 (`Object.is` in `shallowRef`); point 1 redundant | `await nextTick()` |

## Choices

| # | Question | Choice |
| --- | --- | --- |
| 1 | Import or copy P0 | Copy + byte-compare test (the controller's instruction; P0 has no package exports). |
| 2 | Svelte store vs `createSubscriber` | The store contract: it is the model contract verbatim and documented; `createSubscriber` not tried. |
| 3 | Solid `from()` vs own signal | Own `createSignal` with default equality: `from()` uses `equals: false`, so it would lean on point 3 (silent equal writes); the signal leans on point 7 and costs the same 8 lines. |
| 4 | Vue SFC vs render functions | Render functions (`h`) in `.ts`: no Vue plugin, no `vue-tsc`; `tsc` checks them. |
| 5 | A contribution's model replaced under the same id | Setup-once components (Solid, Vue) are keyed by model identity (`<Show keyed>`, `identityKey`); Svelte's `$derived(modelStore(model…))` re-subscribes by itself. |
| 6 | The row checkbox | The click handler puts `checked` back to the model's value before submitting: the model stays the single writer (React re-asserts controlled inputs itself; the others do not). |
| 7 | Two technologies in one shell | A bridge bundle that adapts one renderer slot into another (Svelte → Solid, public `mount`/`unmount` inside a Solid component); hosts and renderers unaware. |

## Dependencies added (exact pins)

`svelte` 5.57.0, `solid-js` 1.9.15, `vue` 3.5.43; dev: `@sveltejs/vite-plugin-svelte` 7.3.0,
`vite-plugin-solid` 2.11.14, `svelte-check` 4.7.6. No React.
