# @statewalker/mvc-blueprint-03

## What it is

The same todo app as `mvc-blueprint-01`, organised to show four choices:

1. **Slots carry everything the UI shows** — panels, dialogs, notifications and action lists are
   contributions to extension points (`src/lib/sys/extension-points.ts`). The UI sees only model
   interfaces and extension-point declarations, and provides renderers.
2. **Models are interfaces** (`*.model.ts`); signal-based implementations (`*.model.impl.ts`) create
   instances.
3. **The UI expresses intent by changing models.** Data lives in data models — the list's selection,
   the editor's draft. An **ActionModel** only says "do it" (Add, Delete, Save, OK) and carries what a
   button or menu item renders: label, icon, enabled, running.
4. **Code is organised by domain**, not by type: `src/lib/todos/{core,list,edit,clear-completed}`,
   `src/lib/notifications`, each holding its models, implementations, commands and controller; the
   UI mirrors the same tree under `src/ui`.

## How to run it

```
pnpm dev            # the app
pnpm test           # node: boundaries, model contract, kernel, controllers, emitted CSS
pnpm test:browser   # Chromium: host, action components, renderers, end to end
pnpm typecheck
pnpm build
```

## Layout

```
src/lib/sys/                 kernel: signals contract, context adapters, model kit, update loop,
                             attempt, extension points, the ActionModel
src/lib/todos/core/          Todo, TodoApi, MemTodoApi, the todos:api adapter
src/lib/todos/todos.commands.ts   todos:changed (a silent broadcast)
src/lib/todos/list/          list model (data, selection, five actions) and its controller
src/lib/todos/edit/          details + form models (Save, Cancel), todos:edit:open, controller
src/lib/todos/clear-completed/   confirm model (Clear, Cancel), todos:clear-completed:ask, controller
src/lib/notifications/       notification model, notifications:notify, controller
src/ui/host/                 React host over ui:* slots, useSlot/useKeyedSlot, useModel, coverage observer
src/ui/sys/                  ActionButton, ActionBar, ActionMenu, Checkbox
src/ui/todos/…, src/ui/notifications/   renderers, one folder per domain
src/app.ts                   the composition root
tests/B0…B4                  boundaries · contract · controllers · host and renderers · the app
```

## Where the rest is documented

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — mechanisms, extension points, the ActionModel, flows, errors, disposal.
- [docs/DECISIONS.md](docs/DECISIONS.md) — how it differs from 01 and 02, and why.
