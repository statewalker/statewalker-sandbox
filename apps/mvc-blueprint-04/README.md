# @statewalker/mvc-blueprint-04 — prototype **P0**

**P0 — the defined architecture**, implemented as written: kernel, bundles, features, loader, the
three model kinds, controllers as activators, views as publications, and per-technology renderers
for **React and plain DOM**, with the full benchmark scenario. It is the yardstick the other
prototypes are measured against.

- Brief (with the lessons section): umbrella repository,
  [`docs/sandbox-apps/architecture/prototypes/P0.md`](../../../../../docs/sandbox-apps/architecture/prototypes/P0.md)
  (`statewalker/umbrella`, path `docs/sandbox-apps/architecture/prototypes/P0.md`).
- The definition it implements: `docs/sandbox-apps/architecture/ARCHITECTURE.md` and
  `docs/sandbox-apps/MODELS.md` in the same repository.
- Full lessons and fitness numbers: [`LESSONS.md`](LESSONS.md).

```
pnpm dev             # http://localhost:5173/?app=workbench.react | workbench.dom | todos.standalone | contacts.standalone
pnpm test            # node: kernel, contract, single writer, commits, dispose, late, standalone, removal, boundaries (+ graph report)
pnpm test:browser    # Chromium: the same e2e scenarios under React and plain DOM, standalone runs, flush per technology
pnpm typecheck       # also compiles the type-level single-writer checks
pnpm build
pnpm loc [prefix…]   # LOC per module (non-blank, non-comment); e.g. pnpm loc src/bundles/hello
```

## Layout

```
src/kernel/               context + adapters (read-then-set guard), useFields, KernelSlots/KernelCommands
                          (bookkeeping for coverage and dispose tests), logger/config, model-kind types, loader
src/kits/                 OPTIONAL helpers: signals (alien-signals, private), model (createAction, stableGroup,
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
scripts/loc.mjs           the LOC script (§13)
```

Every importable module is a folder with an `index.ts`: `@kernel`, `@kit/<name>`, `@b/<bundle>[/api]`.
Only `src/features/*` imports bundle implementations (activators); bundles import the kernel, kits and
API modules only (the boundary suite enforces it).

## What a newcomer must learn — 26 concepts and rules

Kernel (8)

1. **Context** — one flat object per application; namespaced keys (`sys:*`, `<bundle>:*`); services, never data.
2. **Adapter** — a typed key; only kernel `sys:*` adapters have factories; a bundle service is declared
   (key + type) in its API module and set by its provider (`isProvided` → `set`).
3. **Read-then-set throws** — set a key before anyone reads it (a `find` that returns nothing is a read too).
4. **`useFields`** — resolve every dependency in one place, at the top of the activator.
5. **Slot** — an extension point for what *exists*; `provide`/`register` returns a disposer; `observe`
   calls back at once (retained, so any arrival order works). Plain or keyed.
6. **Command** — a typed request with a response for what *happens*; declared by the bundle that
   answers it; not retained (never fire another bundle's command while activating).
7. **Logger** — a child logger per bundle; a failure is logged at `warn` (it is owner state), only a
   broken invariant at `error`.
8. **`sys:config`** — plain host settings (e.g. `shell:notification-timeout-ms`).

Structure (6)

9. **Bundle** — an activator plus at most one API module; imports the kernel, kits and API modules only.
10. **API module** — declarations only: keys, slot and command declarations, model interfaces, view kinds.
11. **Controller** — `(context) => Promise<cleanup | void>`; publishes, listens, returns the reverse;
    after every `await` it checks it is still active.
12. **Feature** — bundles + required features; **application** — features; an application is a controller.
13. **Loader rules** — required features first, bundles in order, rollback on a throwing activator,
    reverse cleanup; missing feature / cycle / mis-ordered provider is an error before activation.
14. **Manifest service declarations** (P0 addition) — `provides` / `requires` / `optional` service keys,
    checked statically by the loader; `lazy: true` for an activator obtained by `import()`.

Models (7)

15. **The model contract** — coarse groups, `getX()` + `onXUpdate(() => void)`, the nine timing points.
16. **Two facets** — `view` (what a renderer gets) and `control` (what the controller keeps), both frozen.
17. **Presentation** — written by the controller only.
18. **Form / input** — written by the view field by field; the controller only seeds or resets it whole.
19. **Action** — the view calls `submit()`; the controller describes it (`label`, `running`, base
    `enabled`); no payload; effective `enabled` derived synchronously.
20. **Single writer** — every field has exactly one writer, fixed by its kind.
21. **Shared state** — published by its single owner as a model in a slot; changed only through a
    command the owner answers (`todos:add/update/remove`, `contacts:update`).

Views and commits (5)

22. **View kind + publication** — a view exists exactly as long as its contribution to `shell:panels` /
    `shell:dialogs` (+ menu, header, notifications).
23. **Renderer** — per technology, keyed by kind; reads view facets, calls view-facet members; never
    publishes, calls a command or reaches a service.
24. **Commit time** — a commit acts on the state captured synchronously in the submit listener.
25. **Refuse or queue** — a submit while running is visibly refused (`running: true`) or queued and
    honoured; never dropped.
26. **Errors are owner state** — form errors / outcome lines; user messages are notifications the owner
    publishes and withdraws; the **coverage report** lists what no one renders or observes.

Kit-only concepts (not counted; `hello` uses none): signals, `stableGroup`, the update loop,
`onSubmits`, `followFirst`, the notifier.

## Choices where the definition was ambiguous

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
| 12 | Cross-bundle action guards | "`enabled` derived in the model" is impossible when the data lives in another bundle's model (contacts link ← `contacts:selection`, Rename ← `todos:selection`, Clear completed ← collection counts): the controller sets the base flag from a synchronous listener — still same-tick. |
| 13 | MODELS.md §6 rebase / conflict, editor refcount | Not built: the benchmark has no concurrent writer of an open record; one editor per app at a time. |
| 14 | `todos.status` removal | `todos.status` is its own feature (requires `todos`), so it can be removed alone. `hello` is in both workbenches. |
