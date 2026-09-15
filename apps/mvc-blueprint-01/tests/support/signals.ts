import { effect, untracked } from "@todo/signals";
import type { TodoListModel } from "@todo/app/models";
import type { SignalsImplementation } from "../../src/lib/signals/contract.js";

/**
 * Test-side helpers for signals: the type of what each Vitest project
 * provides (`ProvidedContext.signals`), and the `watch`/`watchResults`/
 * `snapshotOf` helpers suites use to observe a model without writing it.
 */
declare module "vitest" {
  export interface ProvidedContext {
    /** Which implementation this project resolved `@todo/signals` to. */
    signals: SignalsImplementation;
  }
}

/**
 * Counts how often what `read` reads changes, from now on: an effect whose
 * first run (the subscription itself) is not counted. The signals counterpart
 * of counting RAW `onUpdate` calls in the parent — it counts at the source, so
 * a missing compare-before-write is visible and nothing downstream dedups it.
 *
 * No effect in this app throws (global constraint): a `read()` failure is
 * caught here, inside the effect, and rethrown from `stop()` instead — so it
 * cannot escape unguarded, and a caller who tears the watcher down still
 * learns the read was broken.
 */
export function watch(read: () => unknown): { readonly n: number; stop(): void } {
  let first = true;
  let n = 0;
  let readError: unknown;
  let readFailed = false;
  // Read before anything else: an effect depends on what its last run read.
  const stopEffect = effect(() => {
    try {
      read();
    } catch (error) {
      readFailed = true;
      readError ??= error;
      return;
    }
    if (first) {
      first = false;
      return;
    }
    n++;
  });
  return {
    get n() {
      return n;
    },
    stop() {
      stopEffect();
      if (readFailed) throw readError;
    },
  };
}

/**
 * Counts the CONTROLLER's writes — the results a model holds (`todos`,
 * `lastOutcome`), not the input a view raises. The parent counted these on
 * the outer model's raw `onUpdate`, which input writes never reached.
 */
export const watchResults = (model: TodoListModel) =>
  watch(() => {
    model.control.todos();
    model.view.lastOutcome();
  });

/** Every value either facet exposes, as plain data — what "the view wrote nothing" compares. */
export const snapshotOf = (model: TodoListModel) =>
  untracked(() => ({
    todos: model.control.todos(),
    lastOutcome: model.view.lastOutcome(),
    filterDraft: model.view.filterDraft(),
    showDone: model.view.showDone(),
    refreshCount: model.control.edges.refreshCount(),
    clearCompletedCount: model.control.edges.clearCompletedCount(),
    pending: model.control.edges.pending(),
    toggles: model.control.edges.toggles(),
    removals: model.control.edges.removals(),
  }));
