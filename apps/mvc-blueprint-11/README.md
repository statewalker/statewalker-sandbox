# @statewalker/mvc-blueprint-11 — prototype **P3**

**P3 — commit mechanisms.** A copy of P0 (`apps/mvc-blueprint-04`) where only *how a commit's data
reaches the controller* varies. Three mechanisms run on the same flows, switchable at activation:

| | Mechanism | Who captures the commit | Who says `running` | Where the queue/refuse rule lives |
| --- | --- | --- | --- | --- |
| **A** | controller snapshot (P0) | the controller's submit listener (`s.commit ??= view.getDraft()`) | the controller writes it, a microtask after the submit | controller code (`??=` fold, `running` writes) |
| **B** | form `commit()` | the form model: `save.submit()` freezes the draft into a `commit` group `{ seq, draft }` | derived in the form: a commit is not settled | the form (refuses while a commit is pending) |
| **C** | action-bound commit records | the action: `createCommitAction({ capture })` appends a deep-frozen `{ seq, snapshot }` | derived in the action: a record is not settled | the action's declaration (`queue: true` or refuse) |

- Brief (with the lessons section): umbrella repository,
  [`docs/sandbox-apps/architecture/prototypes/P3.md`](../../../../../docs/sandbox-apps/architecture/prototypes/P3.md)
  (`statewalker/umbrella`, path `docs/sandbox-apps/architecture/prototypes/P3.md`).
- The rule all three implement: ADR-012 (a commit acts on the state at commit time and is never
  silently lost). The base: P0's README and LESSONS in `apps/mvc-blueprint-04`.
- Full lessons and numbers: [`LESSONS.md`](LESSONS.md).

```
pnpm dev             # http://localhost:5173/?app=workbench.react&commit=C   (commit=A|B|C; default C)
pnpm test            # node: project node-A = the whole P0 suite + P3 suites on A;
                     #       node-B / node-C = commits, races, dispose, late, standalone, removal on B / C
pnpm test:browser    # Chromium: the e2e scenarios on React × A, B, C and plain DOM × A
pnpm typecheck       # also compiles the type-level single-writer checks and the wrong-usage @ts-expect-errors
pnpm build
pnpm loc [prefix…]
```

## What changed from P0

- `src/kits/mechanism/` — `byMechanism({ A, B, C })`: a bundle's activator picks its variant from
  `sys:config["commit:mechanism"]` (default `A`).
- `src/kits/commit/` — mechanism C: `createCommitAction` (records, derived `running`, `settle`) and
  `drainCommits` (one serial consumer per controller, commit order across actions, settles each
  record when its handler ends).
- The affected bundles each hold `a/`, `b/`, `c/` (controller + model) behind an `index.ts` that
  dispatches:
  - `contacts.edit` — Save (now a **multi-step commit**: async validation `validate.ts`, then
    `contacts:update`) and Cancel;
  - `todos.rename` — "Rename…" (acts on `todos:selection`) and the dialog's Rename / Cancel;
  - `todos.list` — Add (queued), Toggle / Edit / Delete selected (refused);
  - `todos.clear-completed` — Clear completed and its confirmation. `b/` re-exports `a/`: there is
    no form to put a `commit()` in (see LESSONS).
- `todos.edit` (Todos' Save, "New todo…") is not varied: it has the shape of the Contacts editor.
- The view facets and the API modules are unchanged; so are all renderers (React and DOM).

## Tests added

| File | What |
| --- | --- |
| `tests/commits/races.test.ts` | the race suite, run once per mechanism: change after submit (Save multi-step, Rename, Delete, Add), two submits in one tick, submit while running, cancel during a running (and a failing) save, dispose during a multi-step save, dispose with Adds queued, and where `running` becomes visible |
| `tests/contract/commit-mechanisms.test.ts` | MODELS.md §4 on B's commit group and derived Save state, C's records group, action state and draft; type-level and runtime single-writer over the B/C models; the C kit (deep freeze, same-tick refusal, queue, drain order, throw, stop) |
| `tests/mechanisms/wrong-usage.test.ts` | a deliberately wrong controller per mechanism over the real models; what the types catch and what only a race test catches |
