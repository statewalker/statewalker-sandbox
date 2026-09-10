# Adapters

What changes when the core suites stop running on `MemFilesApi` — C0.5 of the
prototype-adoption work order (FM-5).

Every rung from P0 to C2 ran on `MemFilesApi`. It is synchronous-ish, never denies
permission, never expires, and never fails a write halfway, so three of the
engine's promises had been **asserted but never observed**. This file records what
happened when they were, and it is the place a difference between adapters is
allowed to be written down — on the condition that a test asserts it. A capability
is a fact a suite checks. A fact a suite avoids is an excuse.

## The three adapters

| | `mem` | `opfs` | `node` |
|---|---|---|---|
| class | `MemFilesApi` | `BrowserFilesApi` | `NodeFilesApi` |
| package | `webrun-files-mem@0.7.2` | `webrun-files-browser@0.7.2` | `webrun-files-node@0.7.0` |
| backing store | a `Map` | the real Origin Private File System | a real directory under `os.tmpdir()` |
| runtime | Node | **HeadlessChrome 145**, via Vitest browser mode + Playwright | Node |
| role | control | adapter under test | adapter under test |

`mem` is not a fourth thing under test. It is how the port proves it is a port:
the suite body in `fm-adapters/test/support/core-suite.ts` is one file, and every
assertion in it has to hold on the adapter the adopted suites ran on, or the port
rewrote the specification on its way across.

**OPFS is the File System Access API.** `FileSystemDirectoryHandle`,
`createWritable()`, `removeEntry()`, native `move()` — `BrowserFilesApi` does not
know which root it was handed, which is the point of it taking a handle rather
than opening one. What a user-PICKED root adds, and why it is out of reach, is
["What could not be tested"](#what-could-not-be-tested) below.

## Capability table

`fm-adapters/src/capabilities.ts` is the machine-readable form. The suites read
it, and a case either exercises the capability or asserts its absence.

| | `mem` | `opfs` | `node` |
|---|---|---|---|
| `commitsPartialWrites` | no | **yes** | no |
| `honoursReadSignal` | no | no | no |
| `canDenyWriteMidJob` | no | no | **yes** |
| `canRevokeRootMidFlight` | no | **yes** | **yes** |
| `readsInChunks` | no | **yes** (8 KiB) | **yes** (8 KiB) |
| `suspendsMidBatch` | no | **yes** | **yes** |

Three rows are worth their own paragraph.

**`honoursReadSignal` is `no` everywhere, and that was a bug.** `FilesApi.read`'s
options have carried `signal?: AbortSignal` with the comment "AbortSignal for
cancellation support" since `webrun-files@0.7.0`. No shipped adapter implements
it. Two of the three additionally swallow every read error (`catch { return; }`),
so a read cannot report failure by throwing either — it ends early and silently.
`fm-core` relied on the adapter throwing, so cancellation did not interrupt an
in-flight write at all. `abortableSource` in `fm-core/src/copy-job.ts` is the fix;
the signal is still passed down, so an adapter that does implement it can stop at
the source instead of being unwound one chunk later.

**`commitsPartialWrites` splits the adapters, and both halves are correct.**
`BrowserFilesApi.write` opens a `FileSystemWritableFileStream` and closes it in a
`finally`, so a source that throws mid-stream leaves a **short file committed** —
and `runCopyJob`'s removal of it is a real rollback with something to roll back,
for the first time in this app's record. `NodeFilesApi` and `MemFilesApi` drain
the whole iterable into one buffer and then write once, so a throw means
`fs.writeFile` is never reached and no target is ever created; the rollback is a
no-op over nothing. Only one of them can show the rollback working, which is the
direct answer to why mem hid it for seven rungs.

**`readsInChunks` is the quieter half of the same story.** `MemFilesApi` yields a
whole file in ONE `yield` at any size. There is no mid-stream in it to interrupt,
so a 512 KiB fixture does not help: the problem was never that mem is fast, it is
that mem has no stream.

## The five re-checks

| Re-check | `opfs` | `node` | Outcome |
|---|---|---|---|
| a real interrupted write | observed | observed | **fixed bug** (`abortableSource`) |
| permission denial mid-job | **not possible** | observed | documented capability |
| a handle revoked between enqueue and start | observed | observed | documented capability |
| resume after an expired credential | **not observed** | **not observed** | see below |
| lane serialisation under latency | observed | observed | held, now on real latency |

### 1 · A real interrupted write

Three cases, because the mutation pass needed three to pin `abortableSource`'s two
check sites and the path between them:

- **mid-stream.** A 512 KiB file, cancelled on the 4th chunk by an observer on the
  real source. On OPFS the partial target's size is asserted EXACTLY — `(chunks -
  1) × 8192` — and then it is gone. Before the fix, all 64 chunks arrived after
  `cancel()`, the write completed, and the entry was reported written.
- **before the first chunk.** Cancelled from the engine's `exists()` conflict
  probe, which every transfer makes before reading a byte. On OPFS an empty file
  is committed (the writable is opened before the source is consumed) and removed;
  size 0 is the assertion, because one chunk would mean the abort was noticed one
  chunk too late.
- **a zero-byte source.** The only case the pre-loop check alone catches, because
  the between-chunks check sits before `yield` and therefore already covers an
  abort that landed before chunk 1. A zero-byte file yields nothing on all three
  adapters, and without the pre-loop check a cancelled job copying one writes a
  **complete** empty target and rolls nothing back. The one case where
  cancellation silently committed.

### 2 · Permission denial mid-job — `node` only

`chmod 0o500` on the target root while the job is running, so `fs.writeFile`
raises a real `EACCES`. The job fails with the platform's reason; the process does
not.

OPFS **cannot produce this.** The Origin Private File System has no per-directory
permission model, and its root grant is not narrowable from script —
`queryPermission({ mode: "readwrite" })` on an OPFS root returns `"granted"` and
there is no call that takes it away. The OPFS fixture therefore has no
`denyWrites`, `canDenyWriteMidJob` is `false` for it, and the suite asserts
`Boolean(fixture.denyWrites) === caps.canDenyWriteMidJob` rather than skipping.
That assertion is what stops the absence from quietly becoming an omission.

A second case covers the same denial one level up — a root still readable but no
longer writable must fail to **acquire**, not acquire and then fail at the first
write. The mutation pass asked for it: narrowing `nodeRootProvider`'s check from
`R_OK | W_OK` to `R_OK` survived everything else, because the only revocation any
other case produced was a root removed outright, which fails a read check too.

### 3 · A handle revoked between enqueue and start

The finding is not that the job fails; it is **where**, and the answer is a real
consequence of a P6 decision.

`JobQueue.enqueue` calls `_acquire` synchronously, so a queued job has already
RESOLVED both roots before its lane frees up. That is deliberate — P6: a queued
job that acquired nothing would let the panel that started it drop the last
reference. The consequence, never observed until now:

- **revoked BEFORE enqueue** → the root resolution fails, the registry records
  `status: "failed"` with a reason, the job fails naming the storage, and the other
  storages are untouched. This is P2's promise, reached by a real revocation
  instead of a factory rigged to throw.
- **revoked AFTER enqueue** → the registry cannot see it. The handle is live as far
  as it is concerned, and the job dies at its first real use. On OPFS that looks
  like a job that enumerates to **nothing** and "succeeds" having copied zero
  entries, because `BrowserFilesApi.list` swallows the `NotFoundError` its dead
  handle raises. The lane survives either way, which the next job proves.

That second row is the one worth carrying forward, and it is **FM-1's
`enumerate()` bug arriving by a different route**: there, a job "succeeded" having
copied zero entries because every root was assumed to be a directory; here, because
a root that no longer exists lists as though it were an empty one.
`BrowserFilesApi.list` swallows the `NotFoundError` its dead handle raises and
yields nothing.

**For whoever owns C3.** The mechanism to tell the two apart already exists, and it
is the same one C3 uses to disambiguate an empty path from a missing one: `stats()`
answers `undefined` on a vanished root and the directory variant on a genuinely
empty directory. Both are asserted in the re-check, so C3 inherits a checked fact
rather than a paragraph. And `enumerate()` **already computes it and discards the
answer** — it calls `api.stats(root)`, tests only for `kind === "file"`, and lets
`undefined` fall through to the `list()` branch beside a real directory. The fix is
one line at a place that already has the information.

FM-5 pins the behaviour and does not choose it: "a root that disappeared between
selection and enqueue" is a job-outcome decision — fail the job, or report zero
entries copied — and that belongs with the listing lifecycle, not with an adapter
port.

### 4 · Resume after a genuinely expired credential — NOT OBSERVED

Stated plainly rather than substituted. **Neither browser filesystem has a
credential that expires,** and neither does a local directory:

- OPFS has no credential at all. Its root is granted by origin and lasts as long
  as the origin's storage.
- The File System Access permission grant on a **picked** directory is the real
  analogue — it lapses when every tab for the origin closes, and a handle restored
  from IndexedDB then answers `"prompt"` rather than `"granted"`. Reaching it needs
  `showDirectoryPicker()`, which cannot be driven (below).
- A remote adapter with a real token would give a genuinely expiring credential.
  No credentials were available, so it is scoped out rather than faked.

What **was** observed is the other half of P4's claim, on the real path: a resume
whose source can no longer be re-acquired is reportable rather than a crash, the
registry records the failure with its reason, and the **cursor survives**, so the
job can be resumed again once the storage comes back. The adopted P4 case fakes
this with `get api(): never { throw }` on the spec; this version goes through the
registry and the source is genuinely gone.

### 5 · Lane serialisation under real latency

P6's adopted cases read a `timeline` of `onStart`/`onEnd` — hooks the queue calls,
so they test the queue's own bookkeeping rather than whether any **write** of one
job landed between two writes of another. On mem the two are the same thing,
because a job runs to completion inside one turn. Under real latency they are not.

The stronger claim, in §6.5's form — per-item invariants plus one global
interleaving assertion — is what the re-checks make, as a symmetric pair:

- two jobs on **one** target storage: every write of the first precedes every write
  of the second, over 24 real writes.
- two jobs on **different** target storages: their writes interleave. Without this
  half, a queue that ran every job one at a time would pass the first case.

## The two assertions that could not cross unchanged

Both are TIGHTENED, and neither is relaxed. Each pins something the adopted form
asserted one point of, plus a fact the adopted form got for free and never checked.

**`removed.length === job.completed`** — P3's "reports a precise boundary when
cancelled, and the source keeps the rest". `job.completed` advances a whole batch
at a time, so the equality holds only when no transfer suspends across a batch
boundary. On a real adapter a cancellation landing inside a batch leaves up to
`batchSize - 1` entries moved but uncounted. The port asserts the window
(`completed ≤ removed < completed + batchSize`), that **no source entry was removed
whose target does not exist**, and that the source retains exactly
`40 - removed.length` — the last of which the adopted form derived from the
equality rather than checking.

**`target.writes` compared to sorted order** — P3's "enumerates in deterministic
sorted order" and "walks whole directory trees". `writes` is COMPLETION order
inside a parallel batch, which §6.5 says not to assert;
`/dst/sub/deep/three.txt` beat `/dst/one.txt` on 1 of 3 runs on a real filesystem.
What the engine promises is ENUMERATION order — it sorts rather than trusting
`list()` — and that is what `onBatch` reports. The port asserts the promised order
directly and the per-item fact as a set, plus the structure actually on the target.

## Six cases that used a timer as a precondition

Not an adapter difference — a defect in the cases' form that only a real adapter
could show. Six adopted cases use `await new Promise((r) => setTimeout(r, 0))` to
mean "the job is now in progress". On mem that is exact: every operation settles on
the microtask queue, so a batch begun in a turn always finishes in it, and the
engine's own `yieldControl` macrotask is queued after the test's. On a real adapter
it is a guess, and it loses — `enumerate()` alone spans several macrotasks over 20
real files, so the cancel frequently lands before the first batch, in a state the
case is not about.

Measured: **2 of 3 consecutive runs on `NodeFilesApi` failed, in a different pair
of cases each time.** A flaky test is not a weak test; it is a test that cannot be
relied on to fail. The port establishes the precondition instead, with
`cancelOnBatch` (whose second `onBatch` call is proof the first batch finished and
checkpointed) and, for the pending-dialog case, a promise the resolver resolves
when the dialog is genuinely open.

One fact fell out of that and is now its own case: **a cancel at the start of batch
N still completes batch N**, because the abort check is at the top of the iteration
and has already been passed. The only zero-progress window is during enumeration —
which on a real adapter is the LIKELY moment to be interrupted, enumeration of a
large tree being the longest part of a job, and on mem does not exist at all. A job
interrupted there leaves no cursor, is not reported at startup, and re-runs whole.

## What could not be tested, and why

**A user-picked File System Access directory.** `showDirectoryPicker()` cannot be
driven from Playwright. Measured, not assumed:

- headless Chromium rejects it immediately with
  `AbortError: Failed to execute 'showDirectoryPicker' on 'Window': The user
  aborted a request.` — with and without `--use-fake-ui-for-file-picker`.
- `DataTransferItem.getAsFileSystemHandle()` on a synthetic drop returns **`null`**,
  so drag-and-drop is not a way round it.
- Playwright's `grantPermissions` has no file-system entry; Chromium exposes no CDP
  domain for one.
- headed Chromium launches here, so the native dialog would open — and no
  automation in this repo can answer a native GTK dialog. A human could; a test
  cannot.

What that costs, precisely: the **permission layer** on a picked root — the prompt,
the grant, and its lapse — and with it re-check 4's "genuinely expired credential".
Everything else about `BrowserFilesApi` is the same class over a different handle,
and OPFS exercises it.

**The `native-file-system-adapter` polyfill was considered and rejected.** Its Node
backend implements the File System Access interfaces over real `fs`, and the
adapter under test would still be the shipped `BrowserFilesApi`. But its
`queryPermission` returns `"granted"` unconditionally, so the only thing it would
add over OPFS is a permission grant that cannot be denied — a fake grant, which is
worse than a stated gap.

**A remote adapter.** No credentials were available, so it is out of scope rather
than faked. The corrupt `code-webrun-files-s3-rustfs.tgz` was not touched; two of
its prose findings stand as warnings for whoever re-derives it — bucket CORS must
expose `ETag` or every write over 5 MB fails, and the harness that first "passed"
was running with web security disabled, which is why a green S3 result is not
evidence by default.

## Mutation results

29 mutations, **27 killed, 2 survive.** Both §5.3 shapes were run as their own
batches: final-iteration paths (7, all killed) and symmetric pairs (6, all killed),
plus 9 over the boundary greps (all killed).

Five survivors were diagnosed by widening, per §5.3, and the widenings are kept:

| Survivor | Diagnosis | Fix |
|---|---|---|
| `abortableSource` drops its pre-loop check | uncovered — the between-chunks check covers everything but a zero-chunk source | the zero-byte-source case |
| the abort check moves after `yield` | weak test — `>0 and <BIG_BYTES` tolerated a whole chunk of overrun | the partial size asserted exactly |
| `release()` never resets a READY status | weak test — `status()` after a full release was asserted nowhere | widened P2's release case |
| `reserve()` skips its release-on-failure | weak test — `isLive()` reads the instance, and a leaked pin leaves none | a case where the NEXT holder's release must still dispose |
| the lease never unpins on failure; the lease pins after the await | uncovered — the lease was only ever observed through whether a resolution succeeded | `fm-adapters/test/handle-lease.test.ts` |
| `pruneCompleted` breaks instead of continuing | weak test — the reconstructed C0 case has the abandoned record LAST, so both agree | a three-record case with it in the middle |

### The two that still survive

**`reserve()` pins after the await instead of before it** (§6.6 clause 1). Not
observable through the public surface, and the reason is structural:
`StorageRegistry.acquire` skips its whole async block when `entry.api` is already
set, so it has **no `await` on that path** and pins synchronously by itself. That is
the only state P6's scenario reaches — both storages are pre-acquired by panels. And
when a storage is *not* live, nothing else holds it, so there is no release to race.
`reserve()`'s synchronous pin is therefore redundant given `acquire`'s current
shape, rather than load-bearing. It is kept, because the shape it guards against is
one line of refactoring away, but it is honest to say no test needs it.

**`opfsDirectoryProvider` skips its `isHandlerAccessible` check.** Unreachable on
OPFS: there is no OPFS state in which `getDirectoryHandle(name, { create: false })`
resolves and the handle it returns is dead. The check guards the picked-directory
case — a handle restored from IndexedDB whose target has moved — which is exactly
what could not be tested above. It mirrors what `openBrowserFilesApi` does in the
adapter package itself and is kept for that reason, with no test demanding it.

### Three survivors inherited from FM-1, unchanged

Named in the work order, in suites adopted verbatim, and **not widened here** —
widening them would change a headline count three downstream units assume.

- `narrowStats` accepts a file missing `lastModified`, and separately one missing
  `size`. P1's only negative fixture drops both.
- `targetFor` read from the ring instead of the MRU stack. C2's test builds a state
  where the two coincide.

Did the adapter work make either bite for real? **No.** `narrowStats` is not on any
path these suites take — the engine reads `stats().kind` directly and never narrows
— and a real adapter would not have helped anyway: `NodeFilesApi` and
`BrowserFilesApi` both always report `size` and `lastModified` on a file, so
neither can produce the half-populated stats the weak fixture fails to distinguish.
The ported re-checks do assert the P1 file variant against a real filesystem
(`size` exactly 5 on a 5-byte file, `lastModified` a number, a directory narrowing
to the directory variant), which is new coverage, but it does not reach the
conjunction. `targetFor` is `fm-app`'s and out of this unit's scope.

## Test counts

| File | node project | opfs project |
|---|---|---|
| adopted P0–P6, C0–C2 (12 files) | **124** | — |
| `test/boundaries-adapters.test.ts` | 8 | — |
| `fm-adapters/test/handle-lease.test.ts` | 6 | — |
| `fm-adapters/test/core-suite.{mem,node,opfs}` | 50 + 51 | 50 |
| `fm-adapters/test/rechecks.{mem,node,opfs}` | 12 + 12 | 12 |
| `fm-adapters/test/opfs-smoke.browser.test.ts` | — | 4 |
| | 263 | 66 |

**329 total, all passing. The adopted 124 are still exactly 124**, with no test
edited, skipped or renamed, on the fixed `fm-core`.

`core-suite.node` is one more than the other two (its file adds the
not-running-as-root assertion, without which every `chmod` case would pass
vacuously under uid 0). The re-checks are 12 rather than the five the work order
names because three of them are re-check 1 — one per abort position — and two more
are the symmetric halves of re-checks 3 and 5; the remaining two cover §6.6's lease
and the P1 stats variant on a real filesystem.

## Running it

```bash
pnpm install --ignore-workspace
pnpm test                       # both projects
pnpm vitest run --project node   # everything that needs node:fs
pnpm vitest run --project opfs   # real Chromium, real OPFS
pnpm typecheck                   # root project, then the DOM-enabled adapters one
```

The opfs project needs a Playwright Chromium. `pnpm exec playwright install
chromium` if it is missing. A browser that cannot start is a **failure**, never a
skip: a green suite that quietly stopped running OPFS is worse than a red one.
