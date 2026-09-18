# @statewalker/mvc-blueprint-10 — prototype **P2**

**P2: controllers as state machines.** This is P0 (`apps/mvc-blueprint-04`) with the internals of
three controllers rewritten as hierarchical state machines. `@statewalker/fsm` 0.38.1 is the primary
candidate. `contacts.edit` is written a second time in XState 5.33.2 for comparison. Everything
outside the controllers' bodies is P0's code, unchanged: kernel, API modules, models, renderers,
hosts and the whole P0 test suite.

- Brief (with the lessons section): umbrella repository,
  [`docs/sandbox-apps/architecture/prototypes/P2.md`](../../../../../docs/sandbox-apps/architecture/prototypes/P2.md)
  (`statewalker/umbrella`, path `docs/sandbox-apps/architecture/prototypes/P2.md`).
- Base: [`../mvc-blueprint-04/README.md`](../mvc-blueprint-04/README.md) covers the architecture,
  the 26 concepts and the choices table.
- Full lessons and numbers: [`LESSONS.md`](LESSONS.md).

```
pnpm dev                                  # as P0: ?app=workbench.react | workbench.dom | todos.standalone | contacts.standalone
VITE_CONTACTS_EDIT=xstate pnpm dev        # the same, with the XState edition of contacts.edit
pnpm test                                 # node: P0's 150 tests + 27 P2 tests (tests/machines, tests/dispose/machines.test.ts)
VITE_CONTACTS_EDIT=xstate pnpm test       # the whole suite on the XState edition
pnpm test:browser                         # Chromium (also with VITE_CONTACTS_EDIT=xstate)
pnpm typecheck && pnpm build
```

## What changed from P0

| Where | What |
| --- | --- |
| `src/kits/machine/` | **new kit**, 113 LOC. `startMachine(chart, handlers, {log, name})` runs on `@statewalker/fsm`'s engine (`FsmProcess`) and fixes the runner's hazards (see LESSONS). A state's handler gets `{event, data, send, task}` and returns its exit, or `{exit, states}` to give its children handlers that close over its locals. |
| `src/bundles/todos.edit/` | `machine.ts` (the chart) plus `index.ts` (the handlers). No `active`, `session`, update loop, `pass()` or `??=`. |
| `src/bundles/contacts.edit/` | the same shape. |
| `src/bundles/todos.clear-completed/` | `idle → busy{asking → clearing}`. The dialog's answers are listened to only while `asking`. |
| `src/bundles/contacts.edit.xstate/` | **new bundle**: the same controller in XState v5 (`setup` / `createMachine` / `invoke` / `.provide`). It is selected by `VITE_CONTACTS_EDIT=xstate` in `features/logic.ts`. |
| `tests/machines/` | chart tests with no DOM and no kernel (one per controller), kit tests, the XState machine test, and a characterisation of `@statewalker/fsm` 0.38.1 as published |
| `tests/dispose/machines.test.ts` | stops the app mid-commit for `todos.edit` and `todos.clear-completed`. P0's own test already covers `contacts.edit`. |

## The machine idiom (`@kit/machine`)

```ts
const machine = startMachine(chart, {
  open: (scope) => {                          // entered by `edit` / `compose`; data = what to edit
    const model = createEditorModel(…);
    own(onSubmits(model.control.save, () => scope.send("save", draft())));   // commit captured at submit
    own(slots.register(panelsSlot, …));       // the panel exists exactly as long as `open`
    return {
      exit: () => release(),
      states: {
        editing: () => model.control.save.update({ running: false }),
        saving: ({ data, task }) => {
          model.control.save.update({ running: true });
          task(() => commands.call(…).promise, (result) => (result.ok ? "saved" : "failed"));
        },
      },
    };
  },
}, { log, name: "todos.edit" });
register(() => machine.stop());
```

The kit gives these guarantees, all pinned by `tests/machines/kit.test.ts`:

- Handlers run in a microtask after `send`, never inside the caller's notification.
- An event is checked against the chart when it is **processed**. An event that has no rule at
  that moment is dropped (this is how Save is refused while saving), and it never makes the machine
  leave a state.
- A state's `send`s and its `task` continuations are dropped once that state has exited, and all
  of them are dropped after `stop()`. No "still active?" check is written anywhere.
- A handler that throws is logged at `error` through the bundle's logger.
