# D3-config-session-ephemeral — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/D3-config-session-ephemeral/`._

---

<!-- source: 01-D3 rung record and code.md -->

# D3 — Config, session, and ephemeral storages · rung record

_10 September 2026 · node: 234 passed, 1 skipped (235) · browser: 51 passed · mutations killed: 7/7 (two after strengthening)_

## Two files, two deliberately different write policies

`storages.json` is **hand-editable** and written only on an explicit user
action. `session.json` is **app-authored** and written debounced. Confusing the
two is the failure the separation exists to prevent: fifty session changes are
asserted to leave `storagesWrites` at exactly 1.

Debouncing is asserted by outcome — fifty scheduled changes produce **one**
write, and it contains the **last** state (`/p49`), not the first.

## Versioning: refuse one, discard the other

| File | A version this build does not understand | Why |
| --- | --- | --- |
| `storages.json` | **throws** | Writing a v1 file over a v2 one destroys configuration the user may have hand-written in a newer build |
| `session.json` | **discarded**, returns `undefined` | A session is disposable; refusing to start over a stale layout would be worse than losing it |

Same situation, opposite correct answers, because one file has an author and
the other does not.

## A missing storage keeps its name

`degradedPanel()` turns a session panel whose storage is not configured into a
**named** error panel: `Photos` with `error: "storage usb://photos is not
configured"`. The drive is unplugged; the user should see *Photos —
unavailable*, not an app that failed to start or a panel that silently vanished.
M5 (drop the name) fails.

## Ephemeral storages

Built for one job, never entered in the registry — there is no `storageURI`
anybody could come back to.

**`readOnly(api)`** wraps dropped OS handles, so ingest is an ordinary copy job
and inherits batching, progress, cancel and checkpointing rather than
reimplementing them for drag-and-drop. `write`, `remove` and `move` all throw;
the ingest test shows `job.completed === 2` — the same progress any copy
reports.

**`archiveSink()`** is genuinely write-only and declares **`resumable: false`**.
The engine now takes `resumable` on the job spec and skips checkpointing when
it is false: *a cursor for a stream that cannot be re-opened is a promise that
cannot be kept.* Declaring the truth up front is cheaper than discovering it on
resume.

## The two survivors, and what they exposed

Both first-run survivors were faults in the tests, and both are the same
mistake this ladder keeps rediscovering: **checking the end state instead of
the event.**

**M2 — remove the single-timer guard.** Write counts stayed at 1, because each
leaked timer found `_pending` already consumed. But the leak is real: `dispose()`
can only cancel the *last* timer, so a panel closed mid-debounce writes a
session for an app that no longer exists. The new test disposes mid-debounce
and asserts `sessionWrites === 0`.

**M7 — checkpoint an unresumable target anyway.** `checkpoints.load("zip")`
returned `undefined` either way, because a **completed job clears its cursor**.
"No cursor at the end" is true whether or not one was ever written. The test now
counts writes to the checkpoint store and asserts **zero**.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | session save also writes `storages.json` | 2 |
| M2 | session not debounced (no single-timer guard) | 1 (after adding the dispose case) |
| M3 | newer `storages.json` accepted instead of refused | 1 |
| M4 | foreign session accepted instead of discarded | 1 |
| M5 | missing storage drops the panel's name | 1 |
| M6 | read-only wrapper permits writes | 1 |
| M7 | engine checkpoints an unresumable target | 1 (after counting writes) |

## Still open

**File System Access** — `showDirectoryPicker` needs a user gesture and a
native chooser Playwright cannot drive, so the folder-download path and
revoked-handle behaviour remain unverified. Recorded as a gap rather than
asserted against a stub, for the reason C0.5 made concrete: an assertion that
cannot fail is worse than none.

The pieces around it are done: `readOnly()` for the drop side, `archiveSink()`
with `resumable: false` for the zip download, and the `external: true` drop
request from D2g that hands the host a resolved target.

