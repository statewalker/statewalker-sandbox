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
| C3 listing lifecycle | **written**, red/green from files 11 §2, 08 and 16 §4.4 | **written**, red first | 42 |
| C4 change notification | **written**, red/green from files 09, 11 §6/§8 and 14's P10 | **written**, red first | 36 |
| C5 command surface | **written**, red/green from file 06 and 14's P11 | **written**, red first | 43 |

**Phase B and the promotion: 124 tests.** Of those, **113 are adopted verbatim**
and **11 are reconstructed C0 cases**. No adopted test was edited, skipped or
renamed, and the 124 has not moved since.

**Phase C from C3 onward: 121 more tests, 245 in total.** These rungs had no
archive and no exported draft, so they are neither recovered nor reconstructed —
they are **written red/green from the records**, which is a third and weaker
category. What they are evidence of is that the behaviour the records describe is
achievable and is pinned; they are not evidence of what the September session
built, because the September session did not build them.

The distinction that matters for anyone reading this later: for P0–C2 a failing
test means the transcription is wrong, and for C3 onward a failing test means the
*design* is being changed. The first is a mistake; the second is a decision.

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

## The P0 fake did not merely fail to catch bugs — it made wrong code look right

This is the most valuable finding of the whole adoption, and it is the one worth
reading before deciding to keep a convenient fake anywhere else.

**Three separate defects trace to P0 code that passed its own suite**, and in each
case the P0 fake is why the suite was satisfied:

1. `enumerate()` assumed every root was a directory, so a selection of individual
   files enumerated to nothing and the job "succeeded" having copied zero
   entries. P3–P6 always tested with a directory root and P0 used the fake.
2. The prefix fan-out counted `/dst-old/a.txt` as a change inside `/dst`. P0 only
   ever asserted the true-positive.
3. **P0's override test passed for the wrong reason.** It asserted the copied file
   did not exist — and it did not, *yet*, because with the P0 fake the copy was
   behind a `setTimeout` that had not fired. A true assertion testing the wrong
   thing. The core handler ran the whole time.

§2 of the work order says to delete the fake rather than port it. That is
vindicated three times over: a fake that merely failed to exercise a path would
have left the suite honestly silent, but this one produced *green* tests for code
that was wrong. The second kind is far more expensive, because it is cited as
coverage.

## Bugs the written rungs found in adopted code

None was a transcription error, so none contradicts the 124. All were latent in
code that had passed its own suite.

1. **The prefix fan-out was wrong** (found at C4). P0's `invalidate()` used
   `path.startsWith(this.model.path)`, which makes `/dst-old/a.txt` a change
   inside `/dst` — so a panel re-lists on every change in an unrelated sibling.
   P0 only ever tested the true-positive. Replaced by `covers()`, which puts the
   separator in the test and keeps the exact-match case, with both sides pinned.

2. **A listener's claim does not stop dispatch** (found at C5). The mechanism, in
   full, because the consequence is not obvious from the symptom:

   - The bus stops dispatch when a command **settles**, not when a listener
     **claims**.
   - A listener answering with a promise claims immediately but settles a
     microtask later.
   - So at the moment a negative-priority core handler runs, `cmd.settled` is
     still `false` — even though the host's override has already won.
   - A core handler that acts immediately therefore does the work the host
     overrode. **A host rerouting `files:delete` to a trash mount got the file
     trashed *and* deleted.** That is P11's headline done-when, silently false.

   Every core handler now awaits one shared `overridden(cmd)` guard as its first
   statement: one yield puts the core after every listener's settle, and the bus
   discards a resolution that arrives after settling, so standing down needs no
   answer. Removing the yield fails 4 tests; inverting the guard fails 22. One
   guard beats two inline fixes, because a mutation has one place to attack.

3. **A change raised inside a delivery was stranded** (found at C4). This is the
   worked example of §5.3, and it is worth following because the next person to
   face a surviving mutation will be tempted to assume "uncovered" and move on.

   The mutation survived because nothing covered it. The widened test then
   **failed against the real code too**: `_schedule()` returns early while a
   flush is in flight, and `_flush` is still set during delivery, so a change an
   observer raised while being notified sat in the queue until some unrelated
   invalidation happened to flush it — or forever. That is exactly the
   republishing shape file 11 §6 requires of the cross-tab stage, so the failure
   would have surfaced there and been diagnosed as a BroadcastChannel problem
   rather than a notifier one.

   Only widening told "weak test" and "uncovered code" apart. Assuming either
   would have been wrong: it was both.

## Four standing checks deliberately NOT instantiated

§6's checks are machinery, not prose — which cuts both ways. A check satisfied by
a contrived instance is worse than one honestly marked not-yet-due, because the
contrived test is what gets cited later as coverage. These four absences are
deliberate, and each has a reason:

| Check | Rung | Why there is no instance |
|---|---|---|
| §6.3 serialise what the user answers | C3 | No user-answered decision exists in a listing lifecycle. |
| §6.3 | C4 | Nor in a notifier. A poll answers nothing. |
| §6.3 | C5 | Nor in a command surface. The only candidate is a *host's* approval step, which is the host's code. P5 already implements the rule in the engine, and §6.3 itself says the general form belongs in the **dialog contract** — D1/D1.5. A tested primitive with no consumer is a source file no failing test demanded (§0.2). |
| §6.6 pin synchronously | C3 | No lifetime-bound resource is created. Satisfied by `reserve()` in `fm-core`, untouched here. C4 *does* have an instance — the poll timer — and it is implemented and mutated. |

§6.2 is instantiated everywhere, with one honest repetition: C4 introduces no new
edge field, so `expectEdgeCounter` repeats C3's subject (`refreshCount`, the
user's own answer to staleness) rather than a counter minted to have a new one.

## Two places the records disagree, and how each was resolved

Flagged rather than resolved silently, because §2 of the work order makes file 16
authoritative where it and the work order disagree.

**Per-row cell versus per-storage column.** File 11 §1 says the size and date
*cells* stopped being a per-storage degradation and became a per-row fact. File 16
§4.4 says the size and date *columns* are exercised "per storage capability, **not
just** per entry". These are different statements and both hold: the cell is per
row (a directory renders blank), the available sort columns are per storage (no
mtime, no date sort). The work order's paraphrase drops the "just", which reads as
a contradiction of file 11 — a transcription slip, not a design change. Both are
tested.

**`errors.sortBy` versus `lastOutcome`.** A refused sort was first written as
`lastOutcome.status === "declined"`. But file 08 §5 defines `lastOutcome.seq` as
*the intent's counter*, and `sortBy` is a level field with no counter, so it has
nothing to answer with. File 08 §6–7 put verification in controllers and refusals
in `errors` as keys with params. So a refused sort lands in `errors.sortBy`,
replaced wholesale per pass, and `lastOutcome` is left to intents that do have a
counter. Following the records rather than working around them.

## Known defects in the adopted suites, carried unmodified

**`test/p3-job-engine.test.ts` has never typechecked, and the defect belongs
upstream.** Its own `SpyFilesApi` declares `list(p: string, o?: never)` and then
calls `src.list("/src", { recursive: true })` at line 169. The suite was archived
in that state; nothing here introduced it.

The test is byte-identical and stays that way — editing an adopted test is the
failure mode the whole exercise exists to prevent. But a permanently red
`typecheck` trains everyone to ignore it, which costs more than the error does, so
the file is the single entry in `tsconfig.json`'s `exclude`, with a comment there
pointing back here. `pnpm typecheck` is otherwise clean and therefore meaningful.
The fix belongs wherever the P3 suite lives upstream, as a one-line widening of
`SpyFilesApi`'s `list` signature.

**`fm-app/src/model-kit.ts` has two biome findings, left as the archive produced
them.** A `useImportType` suggestion and a formatting difference. `biome check`
reports them on every run and that is the correct outcome: recovered code is
evidence of what the September ladder wrote, and reformatting it to quiet a tool
would destroy exactly the property that makes it evidence. The same applies to the
adopted test files. Only files this adoption authored are formatted.

**TS 7 and Vite disagree about symlinks.** TypeScript 7.0.2 does not canonicalise
a path inside a symlinked directory where Vite does, so `src/core/job-model.ts`
and `fm-core/src/job-model.ts` were one class to `vitest` and two distinct
declarations to `tsc` — a private-field incompatibility on a type that is
obviously the same type. The fix is that every `@fm/*` alias resolves *through*
the symlink in both `tsconfig.json` and `vitest.config.ts`, so a file has exactly
one identity. Recorded because it will be rediscovered otherwise.

Verified, since two paths to one file is the shape that inflates a count: vitest
collects **15 files, 15 distinct realpaths, no collisions**, nothing reached
through a symlink path, and the sum of per-file cases equals the reported total.

**Three mutations survive the suite, all in adopted tests.** See `README.md` §Mutation
pass. None is a bug in the code here; each is a test that asserts one side of a pair.
