# @statewalker/mvc-blueprint-07 — prototype R3: event-sourced intents

**Prototype R3** of the architecture program. Brief and lessons:
`docs/sandbox-apps/architecture/prototypes/R3.md` in the umbrella repository (the definition it
breaks: `docs/sandbox-apps/architecture/ARCHITECTURE.md`). Full lessons: [LESSONS.md](LESSONS.md).

The benchmark of ARCHITECTURE §14 (shell + Todos + Contacts + the three cross-app interactions,
standalone and removal runs, `hello`, Rename a todo), built with **views appending intents to a
log**, **handlers and projections instead of controllers**, and **commits that are records by
construction**. React only.

```
pnpm dev              # the workbench; ?app=todos | ?app=contacts | ?app=debug (with the intent log viewer)
pnpm test             # node: kernel, model contract, commits, dispose, late subscribers,
                      #       standalone, removal, boundaries, single writer, log growth
pnpm test:browser     # Chromium: React e2e of §14, host arrival orders, log viewer
pnpm typecheck
pnpm build
pnpm loc              # LOC per area (scripts/loc.mjs)
pnpm deps             # dependency-graph report (scripts/deps.mjs)
```

## The idea in one screen

```ts
// An API module declares intents (instead of commands) — the bundle that answers declares it.
export const addTodo = defineIntent<{ title: string }, Todo>("todos:add");

// A handler answers it; its return value (or throw) becomes an OUTCOME record the log appends.
log.handle(addTodo, ({ payload }) => api.add(payload.title));

// A projection folds records (in log order) into a model; it may never append.
log.project((r) => todos.set(foldTodos(todos.get(), r)));

// A view's gesture appends a record whose payload is captured NOW (cloned + frozen): the commit.
const save = intentAction(log, { label: "Save", commit: () => log.append(saveIntent, { session, title: draft.get().title }) });
// save.view.getState().running is derived from the log: this action's records without an outcome.
```

## Layout

```
src/kernel/        context + service keys (read-then-set guard), useFields, loader, logger, slots,
                   the intent log (log.ts), the shared model types (models.ts)
src/kit/           optional: cell/derived (listener set), alienCell (2nd substrate, contract only),
                   intentAction, followSlot/followList; kit/react: useModel, ActionButton
src/bundles/
  shell/api/  (+ api/react.ts)   shell API: header, menu, panels, dialogs, notifications, shell:notify
  shell.notifications/           answers shell:notify; publishes toasts; dismiss/timeout
  shell.react/                   the React host + coverage report
  todos/api/                     Todos API: slots, intents, view kinds
  todos.core/ todos.list/ todos.edit/ todos.clear-completed/ todos.status/ todos.rename/
  todos.ui.react/
  contacts/api/  contacts.core/ contacts.list/ contacts.edit/ contacts.ui.react/
  todos.contacts-link/           interaction (1), its own feature `todos-contacts`
  hello/ (+ api/)  hello.ui.react/   the minimal bundle of §13.1, kernel only
  sys.log-viewer/ (+ api/)  sys.log-viewer.ui.react/   optional intent log viewer
src/features.ts    feature manifests (UI bundles load lazily; headless apps never load React)
src/apps/          manifests (workbench.react, todos.standalone, contacts.standalone, debug), start
tests/             kernel/ contract/ commits/ correctness/ independence/ boundaries/ e2e/ support/
scripts/           graph.mjs (import graph + LOC), deps.mjs, loc.mjs
```

## What a bundle author must learn (16)

Kernel mechanisms and rules; the minimal bundle (`hello`) uses the ones marked •.

1. • **Context and service keys** — one flat context; `defineService`; set before read or it throws.
2. • **A bundle is a controller**: `(context) => Promise<cleanup>`; resolve dependencies at the top.
3. **Features and applications** — manifests; required features first.
4. • **Slots** — retained extension points: `provide`/`register` return a withdrawer; `observe`.
5. **API modules** — declarations only (types, slots, intents, view kinds, service keys).
6. • **The log scope** — `openLog(context, origin)`; `close()` it in the cleanup (it then refuses appends).
7. **Intent** — `defineIntent<P, R>(id, policy)`; the payload is captured (cloned, frozen) at append.
8. • **Event** — `defineEvent<P>(id)`: an intent no one answers; only projections fold it.
9. **Handler** — exactly one per intent type; its return/throw becomes the outcome record.
10. **Outcome record** — `{ ok, value | error, cause }`; `request()` = append + await it.
11. • **Projection** — a pure fold over records in log order; may write its models, may not append;
    `replay` is opt-in and only for side-effect-free folds. Handlers never replay.
12. • **The model contract** — MODELS.md §2–§4 (groups, `getX`/`onXUpdate`, the nine points).
13. • **Action view** — `submit()` appends; `running` is "my record has no outcome"; refuse vs append.
14. • **View kinds and renderers** — publish `{ kind, model }` to a slot; a UI bundle registers the renderer.
15. **Rule: views never touch the log** — they call model members, which append.
16. **Rule: a multi-step handler re-checks the world after each await** with `since(seq)`.

## Mapping P0 → R3

| P0 (ARCHITECTURE) | R3 counterpart |
| --- | --- |
| Command declaration, `call()` → response | intent type; `append()`; `request()` = append + await outcome |
| Command handler that claims | the single `handle(type)`; a second handler throws |
| Command policy `required` / `silent` | intent policy `required` / `optional`; plus events (`none`) |
| Action submit edge (`getSubmits`, controller drains) | `submit()` appends the intent record (`intentAction`) |
| Controller snapshot at submit (ADR-012) | the record's payload, cloned + frozen by the kernel at append |
| Action `running` written by the controller | derived from the log: the action's records with no outcome |
| Controller loop + in-flight guard | a handler per intent; runs may overlap; "refuse" is a declared action property |
| `reportErrors` / form errors written by the controller | failed outcome record; the form error is a projection of outcomes |
| "after any await, check still active" | the scope: closed → appends throw, late outcomes ignored, in-flight → "abandoned" outcome |
| Presentation model written by the controller | projection folding records into a private cell |
| Form / input model | unchanged: a cell outside the log |
| Selection (input) | event records folded by the owner's projection |
| Shared state published by its owner (`todos:collection`) | unchanged: the owner's projection, published in a slot |
| Notification model published by its owner | `shell:notify` intent answered by `shell.notifications` |
| Commands as transient (not retained) | intents are retained in the log; handlers still see only what arrives while registered |
| Slots, context, loader, renderers, host, coverage | unchanged |
| Diagnostics: logger | logger + the log itself; `sys.log-viewer` (92 LOC incl. renderer) |
