# 07 — Can git's lock-file protocol give a crash-safe, linearizable ref compare-and-set on FilesApi, interoperating with native git?

Plan id **X2** (FilesApi atomic primitives). Status: **answered — yes: two small primitives are enough on memory, Node fs and OPFS, and native git and our writers exclude each other.**

## Question

webrun-vcs updates refs with read-then-write: no lock files, no atomic replace (review finding: lost
updates, torn files, native git unaware of our writes). FilesApi has neither an exclusive create nor
an atomicity guarantee for `write`/`move` (the Node adapter overwrites in place; the browser adapter's
`move` can fall back to copy-then-delete). Git and JGit (`LockFile`) solve ref updates with
**`<ref>.lock`**: create it exclusively, write the new value into it, rename it over the ref; an
existing lock means "busy" and is never broken silently.

Can that protocol be implemented over FilesApi plus **two minimal primitives** — `createExclusive`
and `replace` (atomic rename-over) — on memory, Node fs and OPFS, giving a compare-and-set that is
linearizable, crash-safe, and **interoperable with native git** on the same directory?

The lock protocol is chosen over the alternatives in the plan (versioned files, append-only log)
because it is what git itself does: anything else would not be seen by native git (decision D3).

## Reject condition

Rejected if, on any adapter: two concurrent compare-and-sets from the same expected value both
succeed; a crash at any step leaves a ref torn, empty or silently changed; native git can update a
ref while our lock is held, or we can while git's lock is held; or a primitive cannot be provided at
all on one of the three backends.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | 100 concurrent `casRef` calls from the same expected value on one store: exactly one returns `ok`; the others return `mismatch` or `locked`; the final value is the winner's; no `.lock` is left. Runs on memory, Node fs and (R6) OPFS. |
| R2 | 8 Node processes racing on the same directory: exactly one `ok`, final value is that process's. |
| R3 | Native git interop on a real repository: (a) while we hold `refs/heads/main.lock`, `git update-ref` fails; (b) while a git-style lock exists, `casRef` returns `locked` and changes nothing; (c) a value written by `casRef` is what `git rev-parse` reports, and `git fsck` is clean; (d) a value written by `git update-ref` is what we read. |
| R4 | A crash (injected failure) after each step — lock created, lock written, before replace, during replace — leaves the ref with its old or new value, never torn or missing; a crash that leaves a lock makes later `casRef` return `locked` (git does not steal locks either); an explicit `breakLock` recovers. |
| R5 | `createExclusive` on an existing path returns `false` without changing it; `replace` overwrites the target in one step (a reader never sees a partial or missing file). |
| R6 | In Chromium on OPFS: R1 in one page, and two Dedicated Workers racing on the same OPFS directory produce exactly one winner. |

## Scope — what this prototype does NOT do

- No packed-refs, reflog, symbolic refs or multi-ref transactions (X5).
- No KvStore/SQL compare-and-set (X3); FilesApi only.
- No change to webrun-files itself: the primitives are prototyped as adapters around existing FilesApi implementations.
- No CellB/celld, Firefox or WebKit.

## Answer

**Yes.** Git's lock-file protocol — create `<ref>.lock` exclusively holding the new value, compare
under the lock, rename it over the ref — implemented over FilesApi plus two primitives,
**`createExclusive`** and **`replace`**, gives a compare-and-set that holds under 100 concurrent
in-process writers, 8 racing Node processes, 4 racing OPFS workers, and **mixed races between our
processes and native `git update-ref`**, with exactly one winner every time. Native git and our
writers see each other's locks; a crash at any step leaves the old or the new value, never a torn one.

Per backend, the primitives map onto what each platform already has:

| | `createExclusive` | `replace` |
|---|---|---|
| memory | synchronous check-and-set (no `await` inside) | synchronous move |
| Node fs | `open(path, "wx")` (O_CREAT\|O_EXCL — what git and JGit's `createNewFile` use) | `rename(2)` (atomic on POSIX) |
| OPFS | check-then-create **inside a Web Lock** named after the path (OPFS has no exclusive create) | write the target through `createWritable` (committed atomically on close), then remove the source — the target update is atomic, the source removal may lag |

## Verified

All 31 Node tests and 2 Chromium tests pass (`pnpm test 07-lockfile-cas`). Tests marked † were added or tightened after the independent review of #53.

| # | Result |
|---|---|
| R1 | 100 concurrent compare-and-sets from the same value: one `ok`, the rest `mismatch`/`locked`, final value is the winner's, no lock left — memory and Node fs; expected-value semantics (create, mismatch, update, delete) |
| R2 | 8 Node processes started together on one directory: exactly one `ok`, the ref holds its value; every process exits cleanly with a known result, and at least one saw `locked` (proof the run overlapped — stable 5/5 even pinned to 2 cores) † |
| R3 | On a real repository: (a) our held lock makes `git update-ref` fail; (b) a git-style lock makes `casRef` return `locked`, ref unchanged; (c) our written value is what `git rev-parse` reports and `git fsck --strict` is clean; (d) git's written value is what we read; **(e) 4 of our processes and 4 `git update-ref <new> <old>` racing: exactly one winner overall**, children must exit cleanly †; **(f) git holding a prepared transaction (`update-ref --stdin`: start/update/prepare) makes `casRef` return `locked`, then git's commit lands** † (deterministic, unlike the race); **(g) after `git pack-refs --all`, reads fall back to `packed-refs` and updates write a loose ref git honours** †; **(h) deleting a ref that is also packed is refused** (until X5 rewrites `packed-refs`) † |
| R4 | A crash modelled as a dead process (the failing call and every later one throw, so no cleanup runs) at five points — before/after lock creation, before/after the rename, during a delete — with the exact expected outcome per point (old value + lock left, or new value + no lock); a left lock makes `casRef` return `locked` until `breakLock` †. R4b: a lock whose write fails is unlinked and the error rethrown †. |
| R5 | `createExclusive` refuses an existing path and leaves it unchanged; `replace` moves content over an existing target and removes the source. R5b: an empty ref, garbage, or a `ref: …` symref is an error, never "absent" or a value †. R5c: of two concurrent removes, exactly one reports `true` † |
| R6 | OPFS in Chromium: one winner among 50 concurrent compare-and-sets in a page, and among 4 Dedicated Workers racing on one directory, at least one of which saw `locked` (overlap proven; stable 5/5) † |

### Mutation check

| Mutation | Caught by |
|---|---|
| M1 Node `open(…, "w")` instead of `"wx"` | R1, R2, R3, R4, R5 (Node) |
| M2 no expected-value comparison | R1 (all backends), R2, R6 |
| M3 OPFS check-then-create without the Web Lock | R6 — both the in-page race and the worker race fail: without the lock OPFS races even inside one page |
| M5 lock not removed after a mismatch | R1 (all backends) |
| M7 memory adapter `await`s between check and set | R1 (memory) |
| (review) `readRef` without the `packed-refs` fallback | R3 (g) — red before the fix |

## Findings

- **FilesApi as it stands cannot express a safe ref update.** `write` overwrites in place (the Node
  adapter buffers and calls `writeFile`; a crash mid-write tears the file), there is no exclusive
  create, and the browser adapter's `move` falls back to copy-then-delete when native `move()` is
  missing. That is the root of the lost-update and torn-ref findings of the review.
- **OPFS has no exclusive create.** `getFileHandle(name, { create: true })` succeeds whether or not
  the file exists. Exclusivity comes from Web Locks, which span every page and worker of an origin —
  exactly the set of possible OPFS writers. Mutation M3 shows that without it two writers in the same
  page already both "create" the lock.
- **Stale locks are reported, never stolen** — the git behaviour (git prints "Unable to create
  '…/main.lock': File exists" and asks the user to remove it). The plan's draft R3 for X2 asked for
  automatic stale-lock recovery; that would break interoperability with native git (a lock git is
  actively holding would be stolen), so `breakLock` is an explicit call instead.

## What the review of #53 found

- **Packed refs broke the first version.** After `git pack-refs` (which `git gc` runs), a ref lives
  only in `packed-refs`; the loose-only `readRef` returned "absent", so a create silently overwrote
  an existing ref and a delete resurrected the packed value. `readRef` now falls back to
  `packed-refs` (loose overrides packed, as in git), and deleting a packed ref is refused until X5
  implements git's `packed-refs.lock` rewrite.
- **The first crash tests mostly tested error handling.** The fault injector threw once and then let
  the `finally` cleanup run, so "a crash leaves the lock" was rarely exercised. Crashes now behave
  like a dead process, with an exact expected outcome per point.
- **A lock whose write failed was left behind; an error after the rename could remove someone else's
  lock; a broken or symbolic ref read as a value.** All fixed: rollback inside `createExclusive`,
  no unlock once the commit step has started (a throw then means "outcome unknown" — re-read the
  ref), and OID validation.
- **No lock retry.** git retries a ref lock for 100 ms by default (`core.filesRefLockTimeout`);
  `casRef` reports `locked` immediately, so our writers give up sooner than git's. A retry policy is
  for the ref store (X5), not this primitive.

## Corrections

| Earlier belief | What the prototype showed |
|---|---|
| Plan X2 draft: "variants to compare — lock file, versioned files, append-only log" | Only the lock-file protocol is visible to native git (D3), so the others were not built; the decision follows the user's rule to prefer git-compatible behaviour. |
| Plan X2 draft R3: "stale lock is recovered after a lease timeout" | Incompatible with git, which never steals locks. Recovery is explicit (`breakLock`). |
| "OPFS `createWritable` gives atomic replace" (plan) | True for the content of the target; OPFS `replace` is therefore write-target-then-remove-source, and a crash between the two leaves the lock behind (reported as `locked`, like any stale lock). |
| First version of this prototype: "loose refs are enough" | Not once `packed-refs` exists (above). |

## Proposed FilesApi extension (for webrun-files)

```ts
interface FilesApi {
  // … existing methods …
  /** Create `path` with `content` only if nothing exists there; false (unchanged) otherwise.
   *  A failed write rolls the file back. On OPFS, exclusive among callers in the same origin and
   *  storage partition (Web Locks). `content` is a buffer: these are small control files. */
  createExclusive?(path: string, content: Uint8Array): Promise<boolean>;
  /** Make `target` hold `source`'s content in one atomic step, then remove `source`
   *  (rename-over; on OPFS the source removal may lag the target update). */
  replace?(source: string, target: string): Promise<void>;
}
```

Optional methods (capability-detected), so existing adapters keep working; the git-files backend
requires both and refuses to open a repository read-write on an adapter without them. Reversible:
names and placement can change when the webrun-files PR is reviewed.

## Interfaces produced

```ts
interface AtomicFiles { read; exists; remove; createExclusive(path, content): Promise<boolean>; replace(source, target): Promise<void> }
type CasResult = "ok" | "mismatch" | "locked";
function casRef(files: AtomicFiles, ref: string, expected: string | undefined, next: string | undefined): Promise<CasResult>;
function readRef(files: AtomicFiles, ref: string): Promise<string | undefined>;
function breakLock(files: AtomicFiles, ref: string): Promise<boolean>;
function memAtomicFiles(); function nodeAtomicFiles(root: string); function opfsAtomicFiles(root: FileSystemDirectoryHandle);
```

## Promotion grades

| File | Grade | Why |
|---|---|---|
| `tests/*` | **Adopt** | The FilesApi-primitives conformance suite (every adapter must pass R1/R4/R5) and the git interop suite for the git-files backend |
| `src/lockfile.ts` | **Source** | The protocol core of the git-files ref store; X5 adds packed-refs, reflog, symrefs and multi-ref transactions |
| `src/adapters/node.ts`, `opfs.ts`, `mem.ts` | **Guideline** | The primitives belong in webrun-files adapters themselves |

## Open threads (ranked by how much later work they would invalidate)

1. **Multi-ref transactions, packed-refs writes (deletes of packed refs), reflog, symrefs, lock retry** (X5) — git's `update-ref --stdin` takes all locks first, then commits; packed-refs has its own lock.
2. **Upstream the two primitives to webrun-files** (Node, browser, mem, sqlite adapters) with this suite as their conformance tests.
3. **Durability**: no `fsync` of the lock file or directory before rename; git itself does it only with `core.fsync`. Decide the default for the git-files backend.
4. **Windows** rename semantics (target in use) and network file systems are untested.
5. CellB/celld, Firefox, WebKit not run (OPFS behaviour can differ by browser).
