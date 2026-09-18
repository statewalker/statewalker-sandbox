# @statewalker/mvc-blueprint-12 — prototype **P4**

**P4 — one shared reactive substrate across bundles.** A variation of P0 (`apps/mvc-blueprint-04`,
copied as the base in the first commit): the kernel owns one reactive graph, and shared state
(`todos:collection`, `todos:selection`, `contacts:selection`) is published on it as a `Readable<T>`,
so a consumer's `computed` — or an action's `when` guard — reads another bundle's state directly
instead of copying it through `getX`/`onXUpdate` listeners. It breaks ADR-008 on purpose.

- Brief (with the lessons section): umbrella repository,
  [`docs/sandbox-apps/architecture/prototypes/P4.md`](../../../../../docs/sandbox-apps/architecture/prototypes/P4.md)
  (`statewalker/umbrella`, path `docs/sandbox-apps/architecture/prototypes/P4.md`).
- The base it varies: [`../mvc-blueprint-04/README.md`](../mvc-blueprint-04/README.md) (P0).
- Full lessons and fitness numbers: [`LESSONS.md`](LESSONS.md).

```
pnpm dev             # http://localhost:5173/?app=workbench.react | workbench.dom | todos.standalone | contacts.standalone
pnpm test            # node: P0's suites + glitch (P4), interop, substrate reach
pnpm test:glitch-p0  # the SAME glitch test against P0's sources (../mvc-blueprint-04, read-only) — reports, does not gate
pnpm test:browser    # Chromium: the e2e scenarios under React and plain DOM (renderers unchanged from P0)
pnpm typecheck
pnpm build
pnpm loc [prefix…]
```

## What P4 changes relative to P0

| Where | Change |
| --- | --- |
| `src/kernel/reactive.ts` (new) | The substrate: `signal`, `computed`, `effect`, `batch`, `untracked` (moved from `kits/signals`), and **`Readable<T>`** — a branded tracked read `r()` plus the model contract's channel `r.subscribe(listener)`; `readable(read, alive)` publishes a read; `fromChannel(get, on)` bridges a producer that is not on the graph; `track(get, on)` follows a P0-shaped group (`getX`/`onXUpdate`) directly when its getter is a kernel `Readable`, through the bridge otherwise (the opt-in experiment, `tests/interop/optional.test.ts`). The only `alien-signals` import. |
| `kits/signals` | Re-exports the kernel's functions (the kit and `*.model.ts` files read as in P0). |
| `kits/slots` | `firstOf(slots, decl)` — the first contribution of a one-contribution slot as a tracked read (arrival, replacement, withdrawal). |
| `todos/api`, `contacts/api` | `TodosCollectionView { todos, counts }`, `TodosSelectionView { selected }`, `ContactSelectionView { selected }` are `Readable`s (type import from `@kernel`; no library import). |
| `todos.core`, `todos.list`, `contacts.list` | Publish those facets with `readable(...)`. `todos.list`'s items are **derived** from the collection (no `publishItems`); `contacts.list`'s details panel keeps a contract facet of its own. |
| `todos.status` | Header text = derived group over `collection()?.counts()`; no listener. |
| `todos.contacts-link`, `todos.rename`, `todos.clear-completed` | `enabled` is **derived in the action model** (`when:` over another bundle's `Readable`) — the three controller-set cross-bundle guards of P0 (lesson 4) are gone. Commit-time reads call the `Readable` in the submit listener (which runs untracked). |
| `todos.edit` | Reads the collection through `firstOf`. |
| renderers, hosts, `hello`, `contacts:collection` | **Unchanged.** `contacts:collection` stays on `getX`/`onXUpdate` — a shared-state facet not on the substrate, next to ones that are. |

New tests: `tests/glitch/` (black-box, runs against P0 and P4), `tests/interop/` (plain-listener
consumer, plain producer via `fromChannel`, the glitch at the bridge, a `MessageChannel` realm hop,
the opt-in-without-a-second-contract experiment),
`tests/boundaries/substrate.test.ts` (which bundles reach the library, P0 vs P4), and two contract
runs on `Readable`s (`todos:selection`, a hand-rolled producer through `fromChannel`).

## What a newcomer must learn — 28 concepts and rules

P0's 26 (see [P0's README](../mvc-blueprint-04/README.md)), with rule 21 (**shared state**) changed
to "published by its single owner **as `Readable`s on the kernel substrate**", plus:

27. **`Readable` / tracked read** — calling a `Readable` inside a `computed`, an `effect` or an
    action's `when` subscribes; outside (a submit listener, a command handler, an async pass) it is a
    plain read. Derive cross-bundle values; never copy them with a listener.
28. **The bridge** — a producer not on the graph (a listener set, a remote proxy, another realm)
    publishes through `fromChannel`; derivations stay correct but are glitch-free only on the graph.

## Layout

```
src/kernel/               context + adapters (read-then-set guard), useFields, KernelSlots/KernelCommands
                          (bookkeeping for coverage and dispose tests), logger/config, model-kind types, loader,
                          reactive.ts (P4: the shared substrate, Readable, fromChannel)
src/kits/                 OPTIONAL helpers: signals (re-exports the kernel substrate), model (createAction, stableGroup,
                          channels, createValue, onSubmits), loop (update loop, attempt), slots (followFirst,
                          byOrder), notify (owner-published notifications), host (coverage), react (useModel),
                          dom (bind — the DOM binding)
src/bundles/
  shell/api/ (+react, +dom)     the shell API: header, menu, panels, dialogs, notifications, renderer slots,
                                shell:root, shell:coverage
  shell.react/ shell.dom/       the two shell hosts
  shell.test/ (+dom)            the trivial test shell: headless (node) and a minimal DOM host
  todos/api/                    the Todos API
  todos.core/ todos.list/ todos.edit/ todos.clear-completed/ todos.status/ todos.rename/
  todos.ui.react/ todos.ui.dom/
  contacts/api/ contacts.core/ contacts.list/ contacts.edit/ contacts.ui.react/ contacts.ui.dom/
  todos.contacts-link/          interaction (1), feature `todos-contacts`
  hello/ (+api) hello.ui.react/ hello.ui.dom/   the minimal kernel-only bundle (§13.1)
src/features/             logic.ts, react.ts, dom.ts — feature manifests
src/apps/                 workbench.react, workbench.dom, todos.standalone, contacts.standalone
tests/                    kernel/ contract/ commits/ dispose/ late/ standalone/ removal/ boundaries/ e2e/ support/
                          glitch/ interop/ (P4)
scripts/loc.mjs           the LOC script (§13)
```

Every importable module is a folder with an `index.ts`: `@kernel`, `@kit/<name>`, `@b/<bundle>[/api]`.
Only `src/features/*` imports bundle implementations (activators); bundles import the kernel, kits and
API modules only (the boundary suite enforces it).

## Choices where the definition was ambiguous (inherited from P0)

| # | Question | Choice |
| --- | --- | --- |
| 1 | Who owns `todos:collection` | `todos.core` (the service owner). Writes are commands it answers: `todos:add`, `todos:update`, `todos:remove` (added to the Todos API); the collection is patched before the command resolves. No `todos:changed` broadcast (03 had one). Contacts mirrors it: `contacts:collection` + `contacts:update`. |
| 2 | Queue or disable | **Refuse** for Save (both editors), Clear completed (from the ask until the answer is handled), Toggle/Edit/Delete, Rename. **Queue** for Add (every submit honoured with the title it was submitted with). Two refused-mode submits in one tick are one commit on the state of the first (`??=`). |
| 3 | How a renderer shows an app's own action extension points | The list **controller** observes `todos:toolbar-actions` / `todos:selection-actions` (and `contacts:selection-actions`) and folds them, sorted, into presentation groups `getToolbar()` / `getSelectionActions()`. Renderers never read slots; only shell hosts do. |
| 4 | Selection needed by selection actions from other bundles | Added **`todos:selection`** to the Todos API (the definition had `contacts:selection` only); `todos.rename` reads it. |
| 5 | The row checkbox (an action has no payload) | `select([id])` then `toggle.submit()` in one tick; the action's guard is derived in the model, so it is enabled for that same tick. |
| 6 | "Set unless the host already has" vs the guard | `isProvided(ctx, key)` — does not count as a read. `find()` (optional get) does. |
| 7 | `Activator \| (() => Promise<Activator>)` | Indistinguishable at runtime (both are `() => Promise<…>`); a manifest flag `lazy: true` says which. |
| 8 | Coverage: "contributions to known extension points that no one renders" | `KernelSlots` counts observers per key; a slot with contributions and **no observer** is reported `unobserved` (this also lists shared state no one reads — informational). Panels/dialogs whose kind has no renderer in the host's technology are `unrendered`. |
| 9 | Notification timeout "injected by tests" | `sys:config["shell:notification-timeout-ms"]`, read at the top of the owner's activator; `kits/notify` clears the timer on withdrawal. |
| 10 | Where the DOM element comes from | `shell:root` (declared in `shell/api`, set by the application entry / test before activation, `requires`d by the DOM-based hosts). |
| 11 | Menu group order | Unspecified → alphabetical by group key; items by `order` then `id`. |
| 12 | Cross-bundle action guards (P0) — **P4: derived in the action model via `when` over `Readable`s** | "`enabled` derived in the model" is impossible when the data lives in another bundle's model (contacts link ← `contacts:selection`, Rename ← `todos:selection`, Clear completed ← collection counts): the controller sets the base flag from a synchronous listener — still same-tick. |
| 13 | MODELS.md §6 rebase / conflict, editor refcount | Not built: the benchmark has no concurrent writer of an open record; one editor per app at a time. |
| 14 | `todos.status` removal | `todos.status` is its own feature (requires `todos`), so it can be removed alone. `hello` is in both workbenches. |
