import type { Command, Commands } from "@statewalker/shared-commands";
import { type ConfirmModel, uiConfirm, uiNotify, uiShowList } from "@todo/app/models";
import type { ViewAdapter } from "@todo/ui";

/**
 * The honest precondition every real app has, now that `ListController`
 * genuinely emits `ui:show-list` in `activate()` (Task 12): SOMETHING claims
 * it, or `Command.required` rejects with `no-handlers` — which is correct
 * (that is the exact wiring bug the token exists to surface), but is not what
 * most B3/B4 suites are testing. They boot a controller to exercise the
 * reconcile loop, dispose ordering, or the bus itself — not "what happens
 * with no view layer" (that IS covered, deliberately, by
 * `list-controller.test.ts`'s dedicated "no uiShowList handler" case, which
 * must NOT use either helper below). So every other suite gets a trivial,
 * claiming, never-settling renderer instead — the same shape a real
 * `ListView` has from the bus's point of view (claimed, long-lived, closed
 * only by the controller's own `dispose()`), just without a DOM.
 *
 * Two shapes, because two kinds of suite boot a list controller:
 *
 * - `claimListView(bus)` — for a suite that hands `registerViews` a bare
 *   `Commands` and never builds a `ViewAdapter` at all (most of B3, and B4's
 *   ordering suite). Claims directly on the bus via `Commands.listen`,
 *   returning the raw unsubscribe so it can join the suite's own teardown.
 * - `mountListView(adapter)` — for a suite that already owns a real
 *   `ViewAdapter` (B4's dispose-liveness and end-to-end suites). Uses the
 *   adapter's own `on()`, the production entry point.
 *
 * They are not interchangeable. `claimListView` exists separately for a
 * suite (`end-to-end.test.ts`) that asserts on that same adapter's
 * `openViews()`: mounting the list view ON that adapter would make it
 * permanently non-empty — this view never settles until `dispose()` — which
 * would break an assertion the suite makes about a completely different
 * view. Claiming on the raw bus instead keeps the panel off that adapter's
 * books entirely, while still satisfying `Command.required`.
 *
 * B0 boundary note: this module imports `@todo/app/models` (never
 * `@todo/core`) and `@todo/ui`'s public type, so a suite that imports it
 * alongside `@todo/ui` stays within "a todo-ui suite must not import
 * `@todo/core` directly" — the same precedent `end-to-end.test.ts` and
 * `dispose-liveness.test.ts` already set with their own local `seededApi()`.
 */
export function claimListView(bus: Commands): () => void {
  return bus.listen(uiShowList, () => true);
}

/** See `claimListView`'s doc — the `ViewAdapter`-based counterpart. */
export function mountListView(adapter: ViewAdapter): void {
  adapter.on(uiShowList, () => () => {});
}

/**
 * A headless dialog layer: what `answerDialogs` hands back. It records every
 * question and every notification by TEXT, so a suite can assert how many
 * dialogs the controller opened — not merely the end state, which a
 * controller asking twice and a controller asking once both reach.
 */
export interface Dialogs {
  /** Every `uiConfirm` question, in the order the controller asked. */
  readonly confirms: string[];
  /** Every `uiNotify` text, in the order the controller emitted. */
  readonly notifies: string[];
  /**
   * How the NEXT confirm is answered. `true`/`false` answer on a microtask,
   * like a user who clicks at once; `"hold"` claims and leaves the dialog
   * open until the suite calls `answerHeld()`. Mutable mid-test.
   */
  answer: boolean | "hold";
  /** Confirms claimed under `"hold"` and not yet answered. */
  readonly held: number;
  /** Answers every held confirm, oldest first. */
  answerHeld(confirmed: boolean): void;
  /** Unsubscribes both handlers. */
  off(): void;
}

/**
 * Claims `ui:show-dialog:confirm` and `ui:notify` on the raw bus — the same
 * shape and the same reason as `claimListView`: a suite that boots a
 * controller with a bare `Commands` and no `ViewAdapter`. The notify settles
 * itself at once (a toast that timed out instantly); the confirm answers per
 * `answer`. Imports `@todo/app/models` only, so a `@todo/ui` suite may use it.
 */
export function answerDialogs(bus: Commands, answer: Dialogs["answer"] = true): Dialogs {
  const held: Command<ConfirmModel, { confirmed: boolean }>[] = [];
  const offConfirm = bus.listen(uiConfirm, (cmd) => {
    dialogs.confirms.push(cmd.payload.question);
    if (dialogs.answer === "hold") {
      held.push(cmd);
      return true; // claimed, left open
    }
    return Promise.resolve({ confirmed: dialogs.answer });
  });
  const offNotify = bus.listen(uiNotify, (cmd) => {
    dialogs.notifies.push(cmd.payload.text);
    return Promise.resolve();
  });
  const dialogs: Dialogs = {
    confirms: [],
    notifies: [],
    answer,
    get held() {
      return held.length;
    },
    answerHeld(confirmed) {
      for (const cmd of held.splice(0)) cmd.resolve({ confirmed });
    },
    off() {
      offConfirm();
      offNotify();
    },
  };
  return dialogs;
}
