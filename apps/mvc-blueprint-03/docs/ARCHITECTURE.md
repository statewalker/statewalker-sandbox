# Architecture

## 1. Who may do what

| Layer | Observes | Writes / calls | Imports |
| --- | --- | --- | --- |
| UI (`src/ui/**`) | `ui:*` and `actions:*` slots, read only | view-facet intents of models and actions | React, the kit, `@statewalker/shared-registry`, `@sys/extension-points`, `@sys/action/model`, `@<domain>/model`, `@ui/*` |
| Controllers (`*.controller.ts`) | slots, command listeners, action submits | slot contributions, commands, control facets, the todo api | the kernel, their own domain, `@todos/core`, `@todos/events`, other domains' `…/model` and `…/commands` |
| Model implementations (`*.model.impl.ts`) | — | — | `@sys/signals`, `@sys/model-kit`, `@sys/action`, their own `*.model.ts` |
| Composition root (`src/app.ts`) | — | sets the context's services, activates controllers, mounts the host | everything |

`tests/B0-boundaries/boundaries.test.ts` checks each row, as far as its patterns reach.

## 2. Services on the context

`src/app.ts` creates one plain object and sets `sys:commands`, `sys:slots` and `todos:api` through
`shared-adapters` (no factory: an unset service throws). The logger is `shared-logger`'s default.
Every controller resolves its services once, in `activate(ctx)`, with a child logger named after its
domain (`todos.list`, `todos.edit`, `todos.clear-completed`, `notifications`).

## 3. Extension points

| Slot | Contribution | Provided by | Rendered by |
| --- | --- | --- | --- |
| `ui:panels` (keyed) | `{ kind, title, placement, model }` | list (`todos:list`, main), edit (`todos:edit`, side) | React host |
| `ui:dialogs` | `{ kind, model }` | clear-completed | React host |
| `ui:notifications` | `{ kind, model }` | notifications | React host |
| `actions:todos.toolbar` | `{ id, order, action }` | list: Add, Clear completed | `ActionBar` |
| `actions:todos.selection` | `{ id, order, action }` | list: Toggle, Edit, Delete — open to any domain | `ActionMenu` |

A renderer is host-local, keyed by view kind. The coverage observer warns when a contribution has no
renderer or no place.

The React host reads slots through two hooks: `useSlot`, for an unkeyed slot's items (`ActionBar`,
`ActionMenu`, `ui:dialogs`, `ui:notifications`), and `useKeyedSlot`, for a keyed slot's entries
(`ui:panels`, by placement). A row's own buttons — the toggle checkbox, Edit, Delete — call the list's
own actions directly, selecting the row first; they do not go through a slot. `ActionMenu`, opened by
right-click, instead renders whatever is currently contributed to `actions:todos.selection`, so another
domain's action would appear in that context menu without the list knowing about it. Neither
`ActionMenu` nor a contributed dialog has a trigger element to return focus to on close: each remembers
`document.activeElement` when it opens and, if focus was left on `<body>`, refocuses that element once
its own content is gone.

## 4. The ActionModel

`view`: `getState()` (`label`, `icon`, `hint`, `enabled`, `running`), `onStateUpdate`, `submit()`.
`control`: `getSubmits()`, `onSubmitsUpdate`, `update(patch)`. It carries no payload.

- Enablement that follows data is derived in the owning model's implementation: `createAction({ when })`
  publishes `enabled && when()`. A gesture that selects a row and submits in the same tick finds the
  action enabled.
- `submits` is a state-latest edge: `watchSubmits(control).take()` is true once per batch, so two clicks
  in one tick are one intent.
- The controller sets `running` while the intent runs, and may force `enabled: false` (a command with
  no handler).

## 5. Domains and flows

Every action's submit listener is read-only: it captures a snapshot of what the intent means right
then — the list's selection, items and new-title draft; the edit form's baseline todo and draft — and the
controller's pass acts on that snapshot, not on whatever the model holds once its microtask actually
runs.

- **List.** Owns the list model and five actions; contributes its panel and actions. Add → `api.add`,
  clearing the new-title draft afterwards only if it is still what was submitted; Toggle/Delete →
  `api.update`/`api.remove` over the snapshot selection, doing nothing if that selection was empty;
  Edit → `todos:edit:open`; Clear completed → `todos:clear-completed:ask`. Reloads after a change and
  on `todos:changed`.
- **Edit.** Answers `todos:edit:open` with a side panel holding the details and the form. Opens are
  serialised — each waits for the previous one — and an open also waits for any close still in flight
  (from Cancel or from a Save elsewhere) before it registers its own panel, so two opens never race for
  the panel id. Save → `api.update` with only the fields the draft changed against the todo it was
  opened from, so a change made elsewhere meanwhile is not reverted (nothing changed: no call, the
  editor just closes); once that write reaches the api, `todos:changed` is broadcast, the
  save is logged and a "Saved" toast is shown, whether or not this editor is still the current one —
  unless the controller has been disposed; only clearing `running` and marking the form saved are
  skipped once the session has moved on. A
  failure keeps the draft and shows the error.
- **Clear-completed.** Answers `…:ask` by showing a dialog and returning at once. Clear removes the done
  todos and toasts; `todos:changed` is broadcast whenever at least one todo was actually removed, even
  when the pass then fails partway through the rest. Either answer resets OK's `running` before the
  dialog is withdrawn.
- **Notifications.** Answers `notifications:notify` with a toast, withdrawn on dismiss or after a
  timeout.

## 6. Errors

Every intent's work goes through `attempt`: a failure never escapes a loop. (Calls outside a loop — the api read in an `open`/`ask` handler — reject their command instead, and the caller's `attempt` reports it; broadcasts and `notifyUser` never reject.) It becomes the list's
outcome line or the form's error, an error toast, and an error log record; the action's `running`
returns to `false`. There is no error model: a failure lives in its domain model until the next
success, and in a toast until it expires.

## 7. Disposal

Everything is released through `newRegistry()`: controllers, model implementations (their channels and
child actions), per-editor and per-dialog sessions, React roots, and the app root. A registry releases
LIFO and asynchronously, so a model's `dispose()` first sets a synchronous flag (and an `alive` signal
that disables its actions) before releasing. A disposed controller issues no command: work that lands
after `dispose()` is neither broadcast, logged nor toasted, and its models are not written.

## 8. Tests

| Level | What it pins |
| --- | --- |
| B0 | the table in §1 as import rules, with negative controls |
| B1 | MODELS.md §4 points 1–8 on the ActionModel, the list's visible group and the editor's draft; ActionModel specifics |
| B2 | the kernel, extension points, the todos core, and each domain's model and controller, headless |
| B3 | the React host, the action components and every renderer, in Chromium |
| B4 | the whole app through the UI, a failing save, disposal; the emitted CSS |

Run `pnpm test` for B0–B2 and the node half of B3/B4 (anything under `tests/**/*.test.ts`); run
`pnpm test:browser` for the Chromium half (`tests/**/*.test.tsx`).
