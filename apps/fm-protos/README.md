# fm-protos — the File Manager prototype ladder

Twenty-one rungs, restored as runnable code from the Drive session
`notes/drive/2026-09-08.File-Manager/`. **313 tests green** — 260 in Node, 53 in a
real Chromium — and a clean `tsc --noEmit`.

## Why it is laid out this way

Unlike the httpeers shell ladder, where each rung stands alone, this ladder is
**cumulative**: every rung adds to one `fm-core` / `fm-app` / `fm-ui`. So the code
lives once, under `lib/`, and each rung folder holds the acceptance suite that rung
contributed, plus its verbatim record as `README.md`.

```
lib/fm-core/src    registry, engine, checkpoints, conflicts, queue,
                   stats, change-notifier, file-commands, ephemeral
lib/fm-app/src     declarations, panel/panels models, controllers, model-kit,
                   table-model, config-store, open-storage, file-manager
lib/fm-ui/src      view-adapter, panel-view, panel-slots, drag, use-model
<rung>/tests       that rung's acceptance suite
<rung>/README.md   that rung's record, verbatim from Drive
```

The three packages are addressed as `@fm/core`, `@fm/app` and `@fm/ui` — the same
aliases the C-era rungs used. C0's `boundaries.test.ts` polices them: `fm-core`
names no `ui:` command and touches no DOM, `fm-app` imports no ui package, and
`fm-ui` never reaches past the app layer into the core.

## Running it

```sh
pnpm test            # the 260 Node tests
pnpm test:browser    # the 53 Chromium tests (D2b–D2g)
pnpm test:all        # both
pnpm typecheck       # clean

pnpm test:P0 … test:P6      # Phase B — engine, checkpoints, conflicts, queue
pnpm test:C0 … test:C5, test:C05   # Phase C — models, panels, listing, commands
pnpm test:D1, test:D15, test:D2a, test:D2b, test:D3, test:D4, test:D5   # Phase D
```

Every rung is individually runnable; `test:D2b` is the only one that needs a
browser, and it launches Chromium through Playwright.

## The ladder

| Rung | What it settles | Tests |
| --- | --- | --- |
| `P0-architecture-skeleton` | commands, models, controllers, the view seam | 17 |
| `P1-file-stats-discriminant` | what `FilesApi` really guarantees | 8 |
| `P2-storage-registry` | logical names, shared instances, refcounts | 12 |
| `P3-job-engine-walk-batch-cancel` | walk, batch, cursor, cancel | 12 |
| `P4-checkpoint-and-resume` | the cursor record and resume | 9 |
| `P5-conflict-resolution` | serialised decisions, `applyToAll` | 8 |
| `P6-job-queue-and-lifetimes` | synchronous reservation, cleanup before `done` | 8 |
| `C0-packages-and-core-decisions` | package boundaries, as a fact about the files | 13 |
| `C1-model-kit` | model discipline helpers | 11 |
| `C2-panel-set-algebra` | the ring and the MRU stack: two orders, one set | 28 |
| `C3-listing-lifecycle` | navigation, history, sort, filter, failures | 18 |
| `C4-change-notification` | coalesced invalidation, prefix fan-out, polling | 14 |
| `C5-command-surface-and-override` | negative priority orders, it does not stop | 17 |
| `C05-real-adapters` | whether `mem` was lying to us | 12 |
| `D1-ui-protocol` | views are command handlers at four lifetimes | 13 |
| `D15-conflict-dialog-end-to-end` | the dialog, driven by the engine | 7 |
| `D2a-model-driven-table` | the table model and data frame | 16 |
| `D2b-browser-prototypes` | OPFS, the grid at 100k rows, drags | 53 (browser) |
| `D3-config-session-ephemeral` | two files, two write policies | 13 |
| `D4-open-storage-by-command` | opening a filesystem is a command | 14 |
| `D5-assembly-end-to-end` | `FileManager` — the wiring and nothing else | 10 |

See [PROVENANCE.md](PROVENANCE.md) for what is recovered code, what was ported,
and the four defects the restoration surfaced.
