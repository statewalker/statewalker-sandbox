# @statewalker/mvc-blueprint-13 — prototype **P5**

**P5 — the consolidated architecture K** on the full benchmark, with **React and Solid**: P0's
structure, P1's kernel (commands over slots), P3's commit records (mechanism C), and **kernel
scopes** in place of the "check you are still active after `await`" rule. The logic is split into
linked packages with `exports` (D13). The 17 owner decisions of CONSOLIDATION §6 are built as their
**recommended** option, provisionally.

- Brief (goal, acceptance criteria, lessons section): umbrella repository,
  [`docs/sandbox-apps/architecture/prototypes/P5.md`](../../../../../docs/sandbox-apps/architecture/prototypes/P5.md)
  (`statewalker/umbrella`, path `docs/sandbox-apps/architecture/prototypes/P5.md`).
- Specification: `docs/sandbox-apps/architecture/CONSOLIDATION.md` §3 (trait ledger) and §4 (K).
- Full lessons and the fitness table beside P0: [`LESSONS.md`](LESSONS.md).
- Started from P1 (`apps/mvc-blueprint-09`, itself P0 + commands over slots); copied P3's
  `@kit/commit` and races (`apps/mvc-blueprint-11`), U1's Solid binding, renderers and probe
  (`apps/mvc-blueprint-08`), P4's `track`/`firstOf` and glitch test (`apps/mvc-blueprint-12`),
  P2's dispose-mid-commit tests (`apps/mvc-blueprint-10`).

```
pnpm dev             # http://localhost:5173/?app=workbench.react | workbench.solid | todos.react | todos.solid | contacts.react | contacts.solid
pnpm test            # node: kernel (+scope, dispatcher), contract, single writer, commits (+15 races, D4 outcomes), dispose, glitch, late, standalone, removal, boundaries (+graph)
pnpm test:browser    # Chromium: the same e2e scenarios under React and Solid, standalone per technology, flush, binding probe
pnpm typecheck       # also compiles the type-level single-writer checks (`running` is not writable)
pnpm build
pnpm loc [prefix…]   # LOC per module (non-blank, non-comment), e.g. pnpm loc packages/bundles/hello
pnpm packages        # regenerates every package.json from its imports (--check in CI)
```

## K in one screen

```ts
// A controller receives its bundle scope. What it defers is disposed on deactivation.
export const activate: Controller = async (context, scope) => {
  const { slots, log } = fields(context);                       // 1. resolve dependencies
  let session: Scope | undefined;
  scope.defer(answer(slots, contactsEditOpen, async ({ payload }) => {
    void session?.close();                                       //    a new open replaces the session
    const editor = (session = scope.child());                    //    a child scope = one editor
    const model = createForm<ContactDraft>(base);                // 2. create models
    editor.defer(() => model.dispose());
    drainCommits(editor, log,                                    // 4. drain commits
      on(model.control.save, async (draft, { task }) => {        //    the record's snapshot is the argument
        const result = await task(attempt(log, "save", () => call(slots, contactsUpdate, { id, patch: draft }).promise));
        if (!result.ok) return fail(result.message);            //    form (if open) + notification
        notifier.notify({ message: `Saved ${draft.name}`, tone: "success" });
        void editor.close();
      }),
      on(model.control.cancel, () => void editor.close()));
    editor.defer(slots.register(panelsSlot, "contacts:editor", { …, model: model.view })); // 3. publish
  }));
};
```

| Piece | Where | What it guarantees |
| --- | --- | --- |
| `Scope` | `packages/kernel/scope.ts` (84 LOC) | `defer` (reverse disposal; `release` early), `child()` (closed first), `task(p)` (continuation dropped once closed), `signal` (aborted on close). The loader gives each activation a bundle scope and closes them in reverse. |
| Commands | `packages/kernel/commands.ts` (P1) | dispatch over handler slots; first claim stops; errors unwrapped; in-flight calls in `sys:calls`; a claimed call whose handler leaves (its scope closed) rejects `abandoned`. |
| Commit records | `@p5/kit-commit` | `createCommitAction({ capture, queue?, when? })`: `submit()` captures a deep-frozen record; `running` is derived and not writable; refuse by default. `drainCommits(scope, log, …on(action, handler))`: one at a time in submit order; settles each record. |
| Outcome rule (D4) | `drainCommits` | records accepted in a session are handled even after the session closes — the drain continues in the bundle scope; writes to the session's disposed models are ignored and the bundle's notification remains. When the bundle closes, the drain and its `task` continuations are dropped. |
| Cross-bundle guards | `@p5/kit-track` | `trackFirst(slots, decl, pick)` as an action's `when`; glitch-free kit-to-kit (a producer marks its getters `readable`), bridged otherwise. |
| Forms | `@p5/kit-form` | one form factory for both editors and the rename dialog (the ledger's "share model factories through a kit"). |
| Neutral host model | `@p5/kit-shell` | menu groups, header, main/side panels + active tab, dialog stack, toasts, renderer per contribution — the Solid host renders it (D15). |

## Layout (D13: every folder under `packages/` is a package)

```
packages/kernel/              @p5/kernel — context + read-then-set guard, useFields, KernelSlots (bookkeeping),
                              commands over slots, scopes, logger/config, loader, model-kind types
packages/kits/<k>/            @p5/kit-<k> — OPTIONAL: signals (private substrate), model (channels, stableGroup,
                              createValue), commit (C + drain), form, track, slots, notify, host (coverage, focus
                              return), shell (neutral host model), react, solid
packages/bundles/<b>/         @p5/<b> — a bundle's activator ("."), its API module ("./api"), e.g.
                              @p5/todos/api, @p5/todos.core, @p5/shell/api/solid
src/features/ src/apps/       manifests: logic, react, solid features; React and Solid workbenches + standalones
tests/                        kernel/ contract/ commits/ dispose/ glitch/ late/ standalone/ removal/ boundaries/ e2e/ support/
scripts/                      loc.mjs (LOC per module), packages.mjs (package.json from imports; app link: deps)
```

The app links every package (`"@p5/x": "link:packages/…"`), so `@p5/*` resolves through
`node_modules` in Vite, Vitest and `tsc` alike — no alias table. Each package's `package.json`
declares its `@p5/*` dependencies; the boundary suite (R12) fails on an undeclared import or a
cycle. Solid files carry `/** @jsxImportSource solid-js */`; `vite.config.ts` gives Solid's plugin
the Solid paths and React's plugin the rest.

## What a newcomer must learn — P0's 26, rewritten for K

Unchanged from P0 (see `apps/mvc-blueprint-04/README.md`): 1 context, 2 adapter, 3 read-then-set,
4 `useFields`, 5 slot, 7 logger, 8 `sys:config`, 10 API module, 12 feature/application, 13 loader
rules, 14 manifest declarations, 15 the model contract, 16 two facets, 17 presentation, 18 form,
20 single writer, 21 shared state, 22 view kind + publication, 23 renderer.

Rewritten:

- **6 Command** — a slot whose contributions are handlers: `answer` contributes, `call` dispatches
  to the handlers present now; first claim wins; a caller whose owner leaves gets `abandoned` (P1).
- **9 Bundle** — a package: an activator and at most one API module (`./api`); it imports the
  kernel, kits and API modules only, each declared in its `package.json`.
- **11 Controller** — `(context, scope) => Promise<void | cleanup>`; resolves, creates models,
  publishes (`scope.defer(...)`), drains commits. **Scope** replaces "check you are still active
  after every `await`": await through `task(…)`; a session is `scope.child()`.
- **19 Action** — the view calls `submit()` (no payload); the action captures a commit record;
  `running` is derived (a record is unsettled) and cannot be written; label/hint/base `enabled` are
  the controller's.
- **24 Commit time** — a commit is the record captured at `submit()`; the controller's drain hands
  its snapshot to the handler, one at a time, in submit order.
- **25 Refuse or queue** — a declaration: refuse by default, `queue: true` for event edges (Add).
- **26 Errors are owner state** — plus the outcome rule: the narrowest open scope takes the outcome
  (form + notification while the session is open; notification only after it closed; nothing
  after the bundle closed).

Count: **26** as the ledger counts it (Scope added, "check still active" removed); 27 if one counts
Scope as new and the removed rule as part of concept 11. Kit-only (not counted; `hello` uses none):
signals, `stableGroup`, `drainCommits`/`on`, `createForm`, `track`, the notifier, the shell-host
model.

## Decisions (CONSOLIDATION §6), as built — provisional

| # | Built as |
| --- | --- |
| D1 | C: every commit in every controller is a record (`@p5/kit-commit`) |
| D2 | K: drain + scopes; no machines (K-M not tried) |
| D3 | kernel scopes with dropped continuations; no write interception |
| D4 | narrowest open scope; 7 tests (`tests/commits/outcome.test.ts`) |
| D5 | P1's commands over slots |
| D6 | `silent` resolves `undefined` |
| D7 | `abandoned` rejects; `describeError` reads it as "not completed" |
| D8 | refuse by default; Add is `queue: true` |
| D9 | `todos.core` / `contacts.core` own shared state and answer writes |
| D10 | boundary rule R9: an `<app>:api` service is used only by `<app>.core` |
| D11 | private substrate + `@p5/kit-track`; "glitch-free kit-to-kit only" |
| D12 | not exercised (no machines) |
| D13 | package exports: 35 linked packages, R12 |
| D14 | the guard wrapper kept (`packages/kernel/context.ts`) |
| D15 | neutral host model tried for Solid: host 180 LOC (U1: 286), above the 150 bar |
| D16 | `toggleSelected(id)` in the list model |
| D17 | `provides` / `requires` / `optional` + `lazy`, checked by the loader |
