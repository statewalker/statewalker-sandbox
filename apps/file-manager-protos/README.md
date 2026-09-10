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
record's prose and mutation table; everything else is adopted verbatim.
`PROVENANCE.md` is the index and says per rung which is which.

## Layout

One app package, three source roots, because the three-package boundary is what C0
promoted and what `test/boundaries.test.ts` enforces:

```
fm-core/src/      registry, engine, checkpoints, conflicts, queue, stats
fm-app/src/       declarations, models, controllers, bootstrap, model-kit, panels
fm-ui/src/        empty until D1
fm-adapters/src/  C0.5 — OPFS and Node storage adapters, the handle lease, capabilities
src/{core,app,ui}   symlinks onto the first three roots (see below)
test/             P0-P6 suites, the C0 boundary greps, the C0 decisions
fm-app/test/      C1 and C2 suites
fm-adapters/test/ the ported core suites and the C0.5 re-checks
```

`fm-adapters` is the fourth root and the only one that may name a browser global —
that is how C0.5 resolves §6.1's tension rather than loosening it. See
[`ADAPTERS.md`](./ADAPTERS.md).

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
pnpm test                         # all 329, both projects
pnpm vitest run --project node    # the 263 that run in node
pnpm vitest run --project opfs    # the 66 that run in real Chromium
pnpm test p4                      # one rung
pnpm typecheck                    # two projects; see the known defect below
```

**Two vitest projects, one `pnpm test`.** C0.5 runs the core suites against the
real Origin Private File System, so 66 of the 329 execute inside a real Chromium
under Vitest browser mode. A browser that cannot start is a failure, never a skip.
`pnpm exec playwright install chromium` if it is missing.

**Dependencies are pinned explicitly rather than through `catalog:`**, following
`httpeers-shell-protos`: the app has to install and pass on its own. The versions are
the ones the ladder was tested against — `webrun-files@0.7.0`,
`webrun-files-mem@0.7.2`, `shared-commands@0.2.1`, `shared-baseclass@0.1.1`, Zod 4,
TypeScript 7.0.2. **`vitest` is `4.1.11`, not the 5.x the rung records name** — the
workspace catalog is on 4.1.x and the sibling protos app pins 4.1.11. All 124 tests
pass on 4.1.11; no suite depends on a Vitest 5 feature.

`pnpm typecheck` reports exactly one error, at `test/p3-job-engine.test.ts:169`, and it
is a defect in the adopted suite: its own `SpyFilesApi` types away `list`'s options and
then passes them. An adopted test is not edited to make a tool quiet.

## Mutation pass

C0.5 adds its own: **29 mutations, 27 killed**, plus 9 over the boundary greps, all
killed. Both survivors are diagnosed in [`ADAPTERS.md`](./ADAPTERS.md) §Mutation
results — one is redundant-given-`acquire`'s-shape, the other unreachable on OPFS
and kept for the picked-directory case that could not be tested. The FM-1 pass
below is unchanged.


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

C3 onward (listing lifecycle, change notification, the command surface) is FM-2…FM-4
of the work order. `fm-ui` stays empty until D1.

**C0.5's real adapters ARE here** (FM-5), with two gaps stated rather than papered
over: a user-picked File System Access directory, because
`showDirectoryPicker()` cannot be driven from Playwright, and a remote adapter,
because no credentials were available. [`ADAPTERS.md`](./ADAPTERS.md) says what each
costs and what was measured before concluding it.
