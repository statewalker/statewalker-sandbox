import type { IntentLog, IntentRecord } from "../kernel/log.js";
import type { ActionState, ActionView } from "../kernel/models.js";
import { cell, type Readable } from "./cell.js";

export interface IntentActionOptions {
  readonly label: string;
  readonly icon?: string;
  readonly hint?: string;
  /** the owner's derived guard, read synchronously (a gesture that edits then submits finds it current) */
  readonly guard?: Readable<boolean>;
  /**
   * "refuse" (default): while an intent this action appended is pending, `submit()` is ignored and
   * the state shows `running` — a state-latest action (Save). "append": every submit is its own
   * record — an event-edge action (Add); the log is the queue.
   */
  readonly whileRunning?: "refuse" | "append";
  /** Appends the intent(s), capturing the payload NOW. Undefined: nothing to commit. */
  readonly commit: () => IntentRecord | readonly IntentRecord[] | undefined;
}

export interface IntentAction {
  readonly view: ActionView;
  /** the owner's description: label, icon, hint, and the BASE enabled flag */
  update(patch: Partial<Pick<ActionState, "label" | "icon" | "hint" | "enabled">>): void;
  dispose(): void;
}

/**
 * An action whose submit appends an intent. `running` is not written by any reactor: it is a
 * projection of the log — this action's records that have no outcome yet.
 */
export function intentAction(log: IntentLog, options: IntentActionOptions): IntentAction {
  let description = {
    label: options.label,
    icon: options.icon,
    hint: options.hint,
    enabled: true,
  };
  const inFlight = new Set<number>();
  let disposed = false;
  const compute = (): ActionState => ({
    ...description,
    enabled: description.enabled && (options.guard?.get() ?? true),
    running: inFlight.size > 0,
  });
  const state = cell<ActionState>(compute());
  const refresh = () => state.set(compute());
  const offGuard = options.guard?.subscribe(refresh);
  const offLog = log.project((record) => {
    if (record.kind === "outcome" && inFlight.delete(record.cause)) refresh();
  });
  const view: ActionView = Object.freeze({
    getState: state.get,
    onStateUpdate: state.subscribe,
    submit() {
      if (disposed || log.closed) return;
      const current = compute();
      if (!current.enabled) return;
      if (current.running && (options.whileRunning ?? "refuse") === "refuse") return;
      const appended = options.commit();
      const records = appended === undefined ? [] : "seq" in appended ? [appended] : appended;
      for (const record of records) if (log.isPending(record.seq)) inFlight.add(record.seq);
      refresh();
    },
  });
  return {
    view,
    update(patch) {
      description = { ...description, ...patch };
      refresh();
    },
    dispose() {
      disposed = true;
      offGuard?.();
      offLog();
      state.dispose();
    },
  };
}
