# D5-assembly-end-to-end — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/D5-assembly-end-to-end/`._

---

<!-- source: 01-D5 rung record and code.md -->

# D5 — The assembly, end to end · rung record

_10 September 2026 · node: 259 passed, 1 skipped (260) · browser: 53 passed · mutations killed: 5/5 (one after strengthening)_

## What this rung is

`FileManager` — the wiring, and nothing but the wiring. It owns no rules of its
own: it constructs the pieces, connects them in the fixed bootstrap order, and
gets out of the way. Every rule it relies on was settled in an earlier rung.

The end-to-end suite drives it the way a user does, and **reaches past no
public seam**: filesystems arrive through `storages:open`, operations through
`files:*`, views through `ui:*`. If the layering had quietly stopped holding
anywhere, this is where it would show.

## What the suite proves

1. **Two filesystems, two panels.** Both opened by command, both listed; the
   view layer receives two `ui:show-panel` commands and nothing else.
2. **A copy between panels re-lists the target on its own.** The panel is never
   told to refresh — the job's change notification does it (C4).
3. **No picker with two panels.** `targetFor()` reports `needsPicker: false`
   and no menu is shown (C2).
4. **The menu is the registry**, filtered by `files:resolve-actions`; unclaimed,
   the whole namespace is offered (C5).
5. **A conflict resolves through the real dialog** and the answer reaches the
   engine (D1.5).
6. **The session follows the app**: panels added, removed, **and navigated**.
7. **Restore names what it cannot open** — `Photos` survives as a panel with a
   reason; only the live panel gets a view.
8. **Shutdown releases every storage** and closes every view it opened.

## The finding: openers do not replace each other

The first run failed on the second `storages:open` — it returned the **first**
filesystem again.

Both openers were registered as fallbacks at priority −1 with the `cmd.claimed`
guard from C5. Both decline once the command is claimed, so **registration
order decides**: the earliest one wins, and registering a second opener does
not replace the first.

That is correct behaviour, and it was the test's wiring that was wrong — a real
environment has **one** opener for the app's lifetime, answering successive
calls, because the dialog returns a different folder each time. But the
precedence rule was undocumented, so it now has its own test in the D4 suite:
first registration wins; disposing it lets the next take over; a host claiming
at priority 0 overrides both.

The general shape, third time in this project: **a guard that makes a listener
polite also makes it lose to whoever got there first.** Worth stating wherever
the fallback convention is described.

## The mutation that survived

M2 — drop `_scheduleSession()` from the panel's `onUpdate` — passed, because
`addPanel` and `removePanel` schedule it too, and every session test only
created or destroyed panels.

What was lost is navigation: reopening the app would land on the folder the
panel was created with, not the one the user left off in. A test now navigates a
panel and asserts the saved path followed. Same lesson as C0/M2, D3/M2 and
D3/M7: a test that exercises only the coarse path cannot see the fine one.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | panel does not subscribe to change notification | 1 |
| M2 | session not scheduled on panel changes | 1 (after adding the navigation case) |
| M3 | unavailable panel dropped instead of named | 1 |
| M4 | dispose leaves storages held | 1 |
| M5 | target chosen without the MRU rule | 1 |

## Where v1 stands

Everything in file 16 §7's definition of done is now built and tested, with one
exception:

> Two panels over two real storages copy, move, delete, rename and mkdir with
> progress, cancel, per-entry conflicts and resume; drag-in and both
> download-out paths work; N panels with ring/MRU and slots; config and session
> persist; a host can override any file command without touching app code; and
> the whole thing still runs headlessly in Node with no DOM.

**The exception is `showDirectoryPicker`** — the folder-download path and
revoked-handle behaviour. Its two neighbours are done (`archiveSink()` with
`resumable: false`, and `readOnly()` for ingest), and D4 reduced the gap to a
single injected function, but the API itself still cannot be driven by
Playwright. It should be closed by a manual checklist against a real browser,
not by asserting against a stub.

**Totals across the ladder:** 259 Node tests, 53 browser tests, and 21 rungs
from P0 to D5, each archived beside this one.

