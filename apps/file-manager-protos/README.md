# file-manager-protos

The **file-manager prototype ladder** restored as runnable code — ten rungs that build
a two-panel file manager over `FilesApi`, one aspect at a time: a storage registry, a
job engine that walks and batches and cancels, a batch cursor that makes resume exact,
conflict resolution that keeps the core free of any view vocabulary, per-storage job
lanes, and a panel set that is two orders over one id set.

Companion to [`httpeers-shell-protos`](../httpeers-shell-protos), which does the same
for the shell ladder. Both are test suites rather than demos, because every question
on these ladders is answered by an assertion.

## Where this came from

The ladder ran on 8–9 September 2026 and produced ten positive rungs. Its record is
the Drive session `notes/drive/2026-09-08.File-Manager/` — 16 notes plus a folder per
rung, and **all nine archives decompress**, which makes this the best-preserved
prototype in the mirror.

**C0 is the one rung with no archive.** Its eleven tests are reconstructed from the
record's prose and mutation table; everything through C2 is otherwise adopted
verbatim.

**C3 onward never ran at all.** The September session stopped after C2, so the
listing lifecycle, change notification and command surface here are written
red/green from the design records — a weaker kind of evidence, and `PROVENANCE.md` keeps the three
categories apart rather than blurring them.

## Layout

One app package, three source roots, because the three-package boundary is what C0
promoted and what `test/boundaries.test.ts` enforces:

```
fm-core/src/    registry, engine, checkpoints, conflicts, queue, stats, declarations
fm-app/src/     models, controllers, bootstrap, model-kit, panels, notifier, commands
fm-ui/src/      empty until D1
src/{core,app,ui}   symlinks onto the three roots (see below)
test/           P0-P6 suites, the C0 boundary grep, the C0 decisions
fm-app/test/    C1, C2, C3, C4, C5 suites
```

`@fm/core`, `@fm/app` and `@fm/ui` resolve through `tsconfig.json` `paths` **and** a
matching `resolve.alias` in `vitest.config.ts` — both, or `tsc --noEmit` and
`vitest run` disagree about what a package is. Nothing is split into pnpm workspace
packages, so the boundary is enforced by the grep rather than by the resolver. That
makes `test/boundaries.test.ts` load-bearing: it reads the actual files with comments
stripped, because a rule a comment can satisfy is not a rule.

**Why `src/` exists.** The adopted P0 support file imports
`"../../src/app/declarations.js"` and the adopted P5 suite calls
`readdirSync("src/core")`. Neither is editable, so `src/core`, `src/app` and `src/ui`
are symlinks onto the three roots, and every alias resolves *through* them so a file
never has two module identities.

## Running it

```bash
pnpm install --ignore-workspace   # the app is self-contained; see below
pnpm test                         # all of it
pnpm test p4                      # one rung
pnpm test c3                      # one Phase C rung
pnpm typecheck                    # see the known defect below
```

**Dependencies are pinned explicitly rather than through `catalog:`**, following
`httpeers-shell-protos`: the app has to install and pass on its own. The versions are
the ones the ladder was tested against — `webrun-files@0.7.0`,
`webrun-files-mem@0.7.2`, `shared-commands@0.2.1`, `shared-baseclass@0.1.1`, Zod 4,
TypeScript 7.0.2. **`vitest` is `4.1.11`, not the 5.x the rung records name** — the
workspace catalog is on 4.1.x and the sibling protos app pins 4.1.11. All 124 tests
pass on 4.1.11; no suite depends on a Vitest 5 feature.

`pnpm typecheck` is clean. One adopted file is excluded from it —
`test/p3-job-engine.test.ts`, whose own `SpyFilesApi` types away `list`'s options
and then passes them. The test is byte-identical and the defect belongs upstream;
`tsconfig.json` says so at the exclusion and `PROVENANCE.md` has the detail. An
adopted test is not edited to make a tool quiet, and a permanently red `typecheck`
is not left to train everyone to ignore it.

## What each Phase C rung is held to

Every rung from C1 onward runs the three C1 kit helpers against every model it
touches — `expectReplacedNotMutated`, `expectNoSelfWake`, `expectEdgeCounter` —
because `entries.push(...)` + `notify()` is invisible to an `onChange` watcher and
the first P0 suite did not catch it. The kit constrains models as they are
written rather than auditing them afterwards, and file 16 calls that the single
highest-value change in the plan.

Two further standing rules show up as machinery rather than prose:

- **Cleanup precedes settlement.** A panel releases its storage and its observer
  registration *before* `ui:show-panel` settles. Asserted synchronously, not only
  through the settle promise — view removal on settle is a microtask, so the
  promise alone would order them correctly even with a late release, and the test
  would have been worthless.
- **Under concurrency, assert per-item invariants and counts, never order.** A
  500-entry batch is asserted by its 500 individual row marks plus one bounded
  notification count. Nothing anywhere asserts notification order.

## Mutation pass

65 mutations, **61 killed, 3 survive** (plus one mutation whose faithful two-site form
is killed by 1 — the harness's single-site approximation is too weak to be evidence).
Every mutation from every rung record's own table was re-run, plus the two shapes
§5.3 of the work order makes mandatory: **final-iteration paths** (7 mutations, all
killed) and **symmetric pairs** (11 mutations, 3 surviving).

The three survivors are all tests asserting one side of a pair, and all three are in
suites adopted verbatim, so none was widened here:

- **`narrowStats` accepts a file missing `lastModified`** (and, separately, one missing
  `size`). The P1 suite's only negative fixture, `LyingFilesApi`, drops *both* fields,
  so either half of the conjunction catches it. A fixture dropping one field kills both
  mutations; written as a probe, it did.
- **`targetFor` read from the ring instead of the MRU stack.** C2's "is `mru[1]` with
  three or more" test activates `p3, p2, p1` on a set whose ring is already
  `p1, p2, p3` — the two orders coincide, so the test cannot tell them apart. Activating
  so they diverge kills it.

Diagnosed as **weak tests, not uncovered code**, by widening each until it failed —
per §5.3, which says only widening tells the two apart. The widened forms are not kept,
because adding them would change a headline count that three downstream units assume.
They belong with the P1 and C2 suites, upstream.

## What is not here

The real adapters: every rung here runs on `MemFilesApi`, which is
synchronous-ish, never denies permission, never expires and never fails a write
halfway — so partial target removal, re-acquisition failure on resume and lane
serialisation under latency are **asserted but never observed**. That is a
separate unit. `fm-ui` stays empty until D1, and the dialog contract, the
conflict dialog and the React panel are Phase D.

One known design gap, flagged rather than fixed: tier-one notification re-lists
once per *engine batch*, so a 500-file copy re-lists the target directory ~63
times at the default `batchSize` of 8. That satisfies the records ("must not call
notify() 500 times") and it updates during the copy rather than only at the end,
but it is O(batches × directory size). A debounce across batches is the obvious
next step and the records do not specify one.
