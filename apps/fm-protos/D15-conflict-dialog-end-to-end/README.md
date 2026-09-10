# D15-conflict-dialog-end-to-end — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/D15-conflict-dialog-end-to-end/`._

---

<!-- source: 01-D15 rung record and code.md -->

# D1.5 — The conflict dialog, end to end · rung record

_10 September 2026 · green: 205 passed, 1 skipped (206) · 7 new · mutations killed: 5/5_

## Verdict

The seam holds. Engine → command bus → view → answer → engine, with **no test
doubles in the middle**. Promotion grade: **Adopt**.

This rung existed because P5 showed that parallel batches and a
single-decision UI had already collided once. They do not collide now, and the
tests say why.

## Where the suite lives

`test/d15-conflict-dialog.test.ts` — outside the packages, because it
deliberately spans all three layers. Package suites stay inside their package;
an integration suite that imports `fm-core`, `fm-app` and `fm-ui` together
belongs at the root, where it breaks no boundary rule by existing.

## The resolver

Twenty lines. It turns the engine's `onConflict` callback into
`ui:show-dialog:conflict` and back, and its only real work is the abort:

```ts
    const onAbort = () => {
      // Settling the command removes the view: the dialog closes with the job
      // rather than lingering over a job that no longer exists.
      call.reject(new Error("cancelled while awaiting a conflict decision"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
```

The engine already serialises decisions (P5), so only one dialog is ever open.
What the engine cannot do is close a dialog — that needs the command, and the
command lives here.

## Acceptance criteria, as tested

1. The dialog carries the **real** source and target paths (`/src/a.txt` →
   `/dst/a.txt`), not a formatted string.
2. **Fifty conflicts, one dialog** when the user applies to all — and all fifty
   land in `job.skipped` with the job still `done`.
3. Three different answers for three entries when the user does not apply to
   all: overwrite writes, skip leaves the old file, rename writes
   `c (2).txt` and leaves `c.txt` untouched.
4. Cancelling mid-decision ends the job `cancelled`, **closes the dialog**
   (`open === 0`, not orphaned over a dead job), and leaves the target
   untouched.
5. A second job after a cancelled one gets a **fresh question**, not a stuck
   one — the failure mode where an aborted dialog poisons the next job.
6. With no view layer at all, the job **fails reportably**
   (`no-handlers`/`not-claimed`) and writes nothing. Overwriting silently
   because the UI is missing would be the worst possible default.
7. `fm-core` still names no `ui:` string — asserted again here, from the
   integration side, because this is the rung where the temptation to leak it
   is highest.

The renderer itself asserts the invariant continuously: it increments an `open`
counter and `expect(open).toBe(1)` on every render, so a second simultaneous
dialog fails the test wherever it appears.

## The test-timing correction

One test hung: it answered three dialogs with a fixed `setTimeout(0)` between
them, and the third dialog had not opened yet, so `answer()` re-settled an
already-settled command and the job waited forever.

The fix is a `waitForDialog(n)` helper that polls until the Nth dialog actually
opens. The engine yields, stats the target, and serialises the decision before
asking — **the number of ticks that takes is not a property the test should
encode.** Same family as the C4 marks correction: wait for the event, don't
guess when it happens.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| R-M1 | resolver ignores the abort signal | 2 |
| R-M2 | dialog left open after abort (reject without settling the view) | 2 |
| R-M3 | dialog carries the source path as its target | 1 |
| C-M4 | engine stops serialising decisions | 1 |
| C-M5 | `applyToAll` not cached across batches | 1 |

C-M4 and C-M5 are P5's mutations re-run **through the real UI** rather than
against a constant resolver. Both still die, which is the point of this rung:
the serialisation that P5 proved in isolation survives contact with a bus, a
view adapter and a human-shaped delay.

## Next

**D2 — the React panel and virtualization.** 100k entries with interactive
scroll, filter, cursor and selection; job progress reflected from models;
the floating window for a slot-less panel; internal drags on a private MIME
type. It is the one remaining rung whose failure mode is "it works but feels
bad", which tests catch poorly — so it needs a real browser runner, and that is
also where the OPFS and File System Access gaps from C0.5 get closed.

