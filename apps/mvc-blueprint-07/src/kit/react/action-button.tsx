import type { ActionView } from "../../kernel/models.js";
import { useModel } from "./use-model.js";

/** Renders an ActionView: label, enabled, running. A click is the action's `submit()`. */
export function ActionButton({ action, role }: { action: ActionView; role?: string }) {
  const state = useModel(action.getState, action.onStateUpdate);
  return (
    <button
      type="button"
      role={role}
      disabled={!state.enabled || state.running}
      aria-busy={state.running || undefined}
      title={state.hint}
      onClick={() => action.submit()}
    >
      {state.label}
    </button>
  );
}
