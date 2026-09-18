import type { ActionContribution, ActionView } from "@kernel";
import { useSyncExternalStore } from "react";

/**
 * THE React binding: one model group (getter + change channel) through `useSyncExternalStore`.
 * Contract point 7 (stable snapshot identity) is what makes it correct with no cache.
 */
export function useModel<T>(read: () => T, subscribe: (listener: () => void) => () => void): T {
  return useSyncExternalStore(subscribe, read, read);
}

/** Any action as a button: label, hint; disabled while not enabled or running. */
export function ActionButton({ action, className }: { action: ActionView; className?: string }) {
  const state = useModel(action.getState, action.onStateUpdate);
  return (
    <button
      type="button"
      className={className ?? "rounded border px-3 py-1 text-sm disabled:opacity-50"}
      title={state.hint}
      aria-busy={state.running}
      disabled={!state.enabled || state.running}
      onClick={() => action.submit()}
    >
      {state.label}
    </button>
  );
}

/** A list of contributed actions as a toolbar. */
export function ActionBar({
  items,
  label,
}: {
  items: readonly ActionContribution[];
  label: string;
}) {
  return (
    <div role="toolbar" aria-label={label} className="flex flex-wrap gap-2">
      {items.map((c) => (
        <ActionButton key={c.id} action={c.action} />
      ))}
    </div>
  );
}
