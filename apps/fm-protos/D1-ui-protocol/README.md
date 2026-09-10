# D1-ui-protocol — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/D1-ui-protocol/`._

---

<!-- source: 01-D1 rung record and code.md -->

# D1 — UI protocol · rung record

_9 September 2026 · green: 198 passed, 1 skipped (199) · 14 new · mutations killed: 6/6 (one after strengthening)_

## Verdict

`fm-ui` exists and holds one class: `ViewAdapter`. Panels, dialogs,
notifications and menus are one mechanism at four lifetimes, and the file that
touches the bus is the only file that touches the bus. Promotion grade:
**Adopt**.

## The protocol

| Command | Payload model | Result | Lifetime |
| --- | --- | --- | --- |
| `ui:show-panel` | `PanelModel` | `{ closed }` | long-lived |
| `ui:show-job` | `JobModel` | unknown | as long as the job |
| `ui:show-dialog:confirm` | `ConfirmDialogModel` | `{ confirmed }` | one answer |
| `ui:show-dialog:prompt` | `PromptDialogModel` | `{ text }` | one answer |
| `ui:show-dialog:conflict` | `ConflictDialogModel` | `{ resolution, applyToAll }` | one answer |
| `ui:show-menu` | `MenuModel` | `{ selectedKey? }` | one answer |
| `ui:notify` | `NotificationModel` | void | fire and forget |

Every dialog kind gets its **own command and its own typed model**. The
descriptor-driven generic dialog was considered and rejected: the app knows its
dialogs at compile time and should get typed models, while an external
contributor supplies their own command, model and renderer rather than encoding
a form in JSON.

`PromptDialogModel` carries an `input` sub-model with `text` and a
`submitCount` counter — the same level/edge split as a panel, so the C1 kit
applies to dialogs unchanged.

## Contract points, each with a test

**Removal on settle is a microtask, not synchronous.** This was a P0 finding
left as a note; it is now an assertion. The view is still open in the tick where
`settle()` is called, because the bus resolves through async output validation.
A host writing teardown assertions must await.

**Either side may settle.** The user answers, or the controller force-closes.
Removing the `promise.then` wiring fails four tests.

**Cleanup runs BEFORE the caller hears back.** On dispose, the renderer's
cleanup runs, then the command is rejected — so "the caller was answered"
implies "the view is gone". This is file 16 §2.4 (settlement implies release)
applied to views rather than to storages, and the test captures
`openViews().length` from inside the rejection handler to prove the ordering.

**Every handler rejects its outstanding commands on dispose.** A view that
unmounts holding a claimed command would hang its caller forever: the
negative-priority fallback gets no second chance after dispatch, so nobody else
will ever answer.

**A kind with no renderer is not claimed.** The caller gets `not-claimed`,
which is reportable, rather than an exception thrown at a controller that could
do nothing about it. Same rule as the unknown slot in C2: what the view layer
cannot show is the view layer's decision.

**Progress is state, not a request.** There is no progress command anywhere in
the protocol. `ui:show-job` carries the live `JobModel`, and the view re-renders
from its `onUpdate`. The test asserts the adapter holds the *same object*, not a
snapshot.

## The surviving mutation

M5 — hand the renderer the raw `Command` instead of `cmd.payload` — survived
the first pass. Nothing asserted what `view.model` actually *is*: the test only
counted the keys of the view handle, which the mutation leaves untouched.

A renderer handed the command could settle it out of band, inspect the bus, or
read another view's payload. The test now asserts `view.model` **is** the model
instance and has no `payload` property. Sixth first-run survivor across the
whole ladder, and the sixth time the cause was an assertion on a proxy rather
than the thing itself.

## A boundary widened

The D1 suite reached into `@fm/core` to build a `JobModel` — the exact import
`fm-ui` is forbidden to make in `src`. Two fixes rather than an exception:

- the app layer now **publishes** the model types its `ui:*` payloads carry
  (`export { JobModel } from "@fm/core"`), which is how `fm-ui` reaches them
  without naming the core;
- the boundary suite now scans `packages/fm-ui/test` as well as `src`, because
  a suite can breach a boundary as easily as a module can.

## Code

```ts
/**
 * D1 — the view layer is a set of COMMAND HANDLERS.
 *
 * There is no view registry and no "mount panel" API: a controller emits
 * `ui:show-panel(model)` and this claims it, renders, and removes the view when
 * the command settles — by either side. Panels, dialogs, notifications and
 * menus are one mechanism at four different lifetimes.
 *
 * Only this file touches the bus. Components see models.
 */
```

```ts
  /**
   * Every UI handler rejects its outstanding commands on dispose.
   *
   * A view that unmounts holding a claimed command would otherwise hang its
   * caller forever: the negative-priority fallback gets no second chance after
   * dispatch, so nobody else will ever answer. Cleanup runs BEFORE the
   * rejection, so "the caller heard back" implies "the view is gone".
   */
  dispose(): void {
    this._disposed = true;
    for (const off of this._offs) off();
    this._offs.length = 0;
    for (const [cmd, entry] of [...this._open]) {
      this._open.delete(cmd);
      entry.cleanup?.();
      cmd.reject(new Error(`view layer disposed while ${String(entry.kind)} was open`));
    }
  }
```

```ts
        // Removal on settle, whoever settles. This is a MICROTASK, not
        // synchronous — the bus settles through async output validation — so a
        // host writing teardown assertions must await a tick.
        cmd.promise.then(
          () => this._close(cmd),
          () => this._close(cmd),
        );
```

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | dispose leaves callers hanging | 2 |
| M2 | cleanup runs after the rejection | 1 |
| M3 | view not removed when the controller settles | 4 |
| M4 | claims a kind it cannot render | 1 |
| M5 | renderer handed the raw command | 1 (after strengthening) |
| M6 | payload snapshotted instead of passed live | 2 |

## Next

**D1.5 — the conflict dialog end to end.** The engine's `onConflict` callback
routed through `ui:show-dialog:conflict` and back, with one in-flight decision
(P5 §2.3), `applyToAll` honoured across batches, and cancellation aborting a
pending dialog — through the real bus, not a test double. It is the seam where
parallel batches meet a single-decision UI, and the two have collided once
already.

