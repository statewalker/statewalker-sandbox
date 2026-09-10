# Provenance

What in this app is **recovered code**, what is a **reconstruction from a note**, and
what is neither — restored 2026-09-09 from the Drive session
`notes/drive/2026-09-08.File-Manager/`.

The distinction is load-bearing and is never blurred here: recovered code is evidence
of what the September ladder did, a reconstruction is only evidence of what its notes
say.

## The file-manager ladder is the best-preserved thing in the mirror

All nine archives decompress (`gzip -t` clean), and the seven P-rung archives add up
to exactly the 74 tests their records claim. Nothing here had to be rebuilt because an
upload truncated — unlike the shell ladder next door.

What is missing is narrower and is the only gap: **C0 has no archive at all.** Its
record quotes five code fragments and a seven-row mutation table, and nothing else.

For P0–P6 the *sources* live only in the ` ```ts ` fenced blocks of each rung's
`01-*.md` record. That is by design, not a gap —
[file 15](../../../notes/drive/2026-09-08.File-Manager/15-Prototype%20Archive%20Index%20P0-P6.md)
says the archives carry `test/` and config deliberately, since the prose records
carry the code. C1 and C2 are the only rungs whose archives carry `src/` too.

## Per rung

| Rung | Code | Tests | Count |
|---|---|---|---|
| P0 architecture skeleton | from the record's fenced blocks; fake `job-engine.ts` **deleted, not ported** | **recovered**, unmodified | 17 |
| P1 `FileStats` discriminant | from the record's fenced blocks | **recovered**, unmodified | 8 |
| P2 storage registry | from the record's fenced blocks (+ P6's `reserve`) | **recovered**, unmodified | 12 |
| P3 job engine | from the record's fenced blocks | **recovered**, unmodified | 12 |
| P4 checkpoint and resume | from the record's fenced blocks | **recovered**, unmodified | 9 |
| P5 conflict resolution | from the record's fenced blocks | **recovered**, unmodified | 8 |
| P6 job queue and lifetimes | from the record's fenced blocks | **recovered**, unmodified | 8 |
| C0 packages and core decisions | fragments from the record, the rest reconstructed | **reconstructed** — no archive exists | 11 |
| C1 model kit | **recovered** `model-kit.ts` (one signature widened) | **recovered**, unmodified | 11 |
| C2 panel set algebra | **recovered** `panels-model.ts`, byte-for-byte | **recovered**, unmodified | 28 |

**124 tests, 12 files.** Of those, **113 are adopted verbatim** and **11 are
reconstructed C0 cases**. No adopted test was edited, skipped or renamed.

### The 11 reconstructed C0 cases, and why each exists

`test/boundaries.test.ts` — 6 cases. The C0 record states the rule in prose
("`fm-core` names no `ui:` command, imports no `@fm/app` or `@fm/ui`, and touches no
DOM global; `fm-app` imports no `@fm/ui` and touches no DOM global; `fm-ui` never
imports `@fm/core` directly") but quotes no code. One case per clause.

`test/c0-decisions.test.ts` — 5 cases, one per C0 mutation whose test did not survive:

| C0 mutation | Reconstructed case |
|---|---|
| C0-M1 queue ignores per-storage `batchSize` | the **target** storage governs batching, not the source and not a global |
| C0-M2 `discard` leaves `errors.json` behind | `discard` removes both, asserted on a job that actually produced errors |
| C0-M3 `pruneCompleted` prunes on age | only `remaining === 0`; an abandoned transfer is kept |
| C0-M5 `onWritten` reports the source path | the target path, on the **move** branch as well as the copy branch |
| C0-M6 errors written only at the end | an error raised in the **final** batch is still recorded |

Each was confirmed to fail against its mutation before being kept. Five is also
exactly the arithmetic the records imply: 74 (P0–P6) + 11 (C0) + 11 (C1) + 28 (C2) =
124, with the boundary suite accounting for six of C0's eleven.

## Departures from the literal records, and the reason for each

**The P0 fake `job-engine.ts` is not here.** C0 replaced it with the real
`runCopyJob`, and deleting it is what exposed the two bugs below. Porting it would
have kept them hidden.

**`ui:show-job` is declared in `fm-app`, not `fm-core`.** P0 put it next to
`files:copy`; P5's correction 1 moved it, and the boundary grep is what found it. The
final state of the ladder is what is restored, not P0's intermediate state.

**`JobsController` is reconstructed.** The C0 record says the app controller drives
`runCopyJob` and shows none of it. The adopted P0 suite pins the behaviour: a `jobId`
answered synchronously, a host listener at priority 0 overriding the core's at −1
*without the core copying anything*, a live `JobModel` crossing as a payload, and the
target panel re-listing on its own. The listener therefore answers with an
already-resolved promise (so dispatch order decides who the caller hears, which is
what priority means) and does its work behind one yield, after checking `cmd.settled`.
Without the yield the core performs the copy a host had already overridden; without
the synchronous answer, the core wins from any priority and the override stops being
observable at all.

**One C1 signature widened.** `expectReplacedNotMutated` and `expectNoSelfWake` take
`write: () => unknown` rather than the record's `() => void | Promise<void>`, because
the adopted C2 suite passes `() => panels.add({...})`, which returns a `PanelModel`.
The suite is the specification; the helper is what has to satisfy it. Runtime
behaviour is unchanged.

**`src/{core,app,ui}` are symlinks onto `fm-{core,app,ui}/src`.** Not a stylistic
choice: the adopted `test/support/fake-view-layer.ts` imports
`"../../src/app/declarations.js"` and the adopted `test/p5-conflicts.test.ts` calls
`readdirSync("src/core")`, and neither is editable. Every `@fm/*` alias resolves
*through* the symlink in both `tsconfig.json` and `vitest.config.ts`, so a file has
one identity and not two.

## The two bugs deleting the fake engine exposed

Both are C0's, both are fixed here, and both are now held by a test.

1. **The engine could not copy a file, only a directory.** `enumerate()` assumed every
   root was a directory and called `list(root, { recursive: true })` on it, so a
   selection of individual files enumerated to nothing and the job "succeeded" having
   copied zero entries. It survived because P3–P6 always tested with a directory root
   and P0 used the fake. `enumerate()` now stats each root: a file contributes itself
   under its basename. The adopted P0 suite demands this — it copies `/src/a.txt`.
   Reverting the fix fails 3 tests.

2. **A cancelled job lost its skip record.** `recordErrors()` ran only after the loop,
   and cancellation returns from inside it, so a job cancelled after the user chose
   "skip" wrote no `errors.json` and the resumed job asked about those entries again.
   Errors now ride the same barrier as the cursor, written per batch when the list
   grows. Reverting the fix fails 2 tests; confining it to non-final batches fails 1.

## Known defects in the adopted suites, carried unmodified

**`test/p3-job-engine.test.ts:169` does not typecheck.** Its own `SpyFilesApi`
declares `list(p: string, o?: never)` and then calls
`src.list("/src", { recursive: true })`. `pnpm test` is green; `pnpm typecheck`
reports this one error and nothing else. Editing an adopted test to silence it is the
failure mode the whole exercise exists to prevent, so it stands.

**Three mutations survive the suite, all in adopted tests.** See `README.md` §Mutation
pass. None is a bug in the code here; each is a test that asserts one side of a pair.
