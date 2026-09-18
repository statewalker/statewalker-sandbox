# mvc-blueprint-05 — prototype R1: Elm/MVI single store

Prototype **R1** of the architecture program. Brief:
[`docs/sandbox-apps/architecture/prototypes/R1.md`](../../../../../docs/sandbox-apps/architecture/prototypes/R1.md)
(in the umbrella). Lessons: [`LESSONS.md`](LESSONS.md).

The benchmark of ARCHITECTURE §14 (shell + Todos + Contacts + the three cross-app interactions +
standalone runs + `hello` + Rename a todo) with **no controllers and no action models**: one store
per application; bundles contribute **update functions**, **effect handlers**, **subscriptions** and
**derivations** to the store's extension points; views get plain data and `dispatch`.

```sh
pnpm dev                 # workbench.react; ?app=todos.standalone | contacts.standalone
pnpm test                # node: store contract, scenarios, commits, single writer, dispose, late, removal, boundaries
pnpm test:browser        # Chromium e2e: the same scenarios through React
pnpm typecheck && pnpm build
node scripts/loc.mjs     # LOC per bundle (§13 definition)
node scripts/deps.mjs    # dependency-graph report
```

## Layout

```
src/kernel/        context + adapters (read-then-set guard), useFields, logger, loader,
                   store.ts (the store), messages.ts (defineMsg), views.ts (ActionItem, ViewKind)
src/bundles/
  shell/api/       points: shell:header, :menu, :panels, :dialogs, :notifications; shell/notify; api/react.ts
  shell.core/      owns the toasts (slice + timer subscriptions)
  shell.react/     the React host (every region is `select(point)`) + binding (usePoint)
  todos/api/       Todos API: types, points, public messages, the todos/api effect, view kinds, view intents
  todos.core/ todos.list/ todos.edit/ todos.clear-completed/ todos.status/ todos.rename/ todos.ui.react/
  contacts/api/  contacts.core/ contacts.list/ contacts.edit/ contacts.ui.react/
  todos.contacts-link/   interaction (1)
  hello/ hello.ui.react/ the minimal bundle
src/features.ts, features.react.ts, apps/index.ts, main.tsx
tests/             contract/ scenario/ commits/ single-writer/ dispose/ late/ removal/ boundaries/
                   composition/ (classic TEA nesting, for comparison) e2e/ (browser)
```

## What a bundle author must learn (the count reported in the fitness table)

Concepts (13):

1. **Bundle / activator** — wiring only: registers things with the store and returns their disposers.
2. **Feature / application** manifests and the loader (required features first).
3. **Context + adapters** — `getStore`, resolved at the top of the activator with `useFields`;
   host configuration (an injected api, a toast timeout) is read the same way; read-then-set throws.
4. **The store** — one frozen state tree per application.
5. **Slice** — `addSlice({ id, init, update, subscriptions? })`; the id is the bundle id.
6. **Message** — `{ type: "<ns>/<name>", …payload }`, declared with `defineMsg`; public ones live in
   the API module.
7. **Update** — pure `(state, msg, { select }) → state | next(state, ...effects)`. It sees *every*
   message and returns its state unchanged for the ones it ignores.
8. **Effect + effect handler** — an effect is data an update returns; the bundle that owns the
   service registers the handler; results come back as messages (a *reply* type + a `ref`).
9. **Subscription** — data derived from state (`afterSub(key, ms, msg)`), diffed by key.
10. **Point + contribution** — an extension point whose contributions are *derivations* of a slice
    (`slice.contribute(point, key, (state, select) => items)`), or of other points.
11. **select** — reads a point: in derivations, in updates (state before the message), in handlers.
12. **ActionItem** — `{ label, enabled, running?, msg }`: an action as data; the view dispatches `msg`.
13. **View kind + renderer + view intents** — a renderer is `({ props, dispatch }) => …`, contributed
    to `ui.react:renderers`; the messages it dispatches are declared in the owner's API module.

Rules (7):

1. Only your update writes your slice (enforced: frozen state, second writer throws).
2. Read other bundles only through points they publish; change them only through the public
   messages or effects their API module declares.
3. Async and IO only in effect handlers; everything they learn comes back as a message.
4. A commit reads what it acts on inside the update (never from a view-built payload), and refuses
   a second commit visibly (`enabled: false` / `running: true`) while one is in flight.
5. An outcome message carries the `ref` of the session that asked; a stale one is ignored.
6. Views render props and dispatch — no store, no service, no effect.
7. Every registration returns a disposer; the activator returns them all (`disposers(...)`).

## Decisions and deviations (vs ARCHITECTURE / P0)

- **Messages broadcast to every slice** (Redux-style) instead of TEA's wrapper-Msg nesting.
  `tests/composition/tea-nesting.test.ts` implements the nested alternative for comparison.
- **Commands are gone.** `todos:compose`, `todos:edit:open`, `todos:clear-completed:ask`,
  `contacts:edit:open` are fire-and-forget public messages; "resolves when the editor is published"
  has no equivalent — the caller observes state instead.
- **Api calls are effects declared in the owner's API** (`todos/api`, `contacts/update`), performed
  by the core bundle; the requester names a reply type and a `ref`.
- **API additions**: `todos:selection` (Edit/Rename read the list selection), `contacts:collection`
  (the list reads the contacts), and view-intent messages per view kind.
- **Toasts are owned by `shell.core`** (`shell/notify`), not by each publisher; the 4 s timeout is a
  subscription; tests inject `shell:notification-timeout-ms`.
- **Queue vs disable**: disable — every commit sets `saving/running` synchronously, the action shows
  it, and a second commit message is a no-op.
- **`todos:collection` is owned by `todos.core`** (the slice that holds the service's data).
