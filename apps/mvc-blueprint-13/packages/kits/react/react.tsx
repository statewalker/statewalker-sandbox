import type { ActionContribution, ActionView, ViewKind } from "@p5/kernel";
import type { ReactRenderer } from "@p5/shell/api/react";
import type { ComponentType } from "react";
import { createContext, useContext, useRef, useSyncExternalStore } from "react";

/** Dev builds (and tests); a production build drops the guard below. */

/** Set by the host around each contribution it renders (`<slot> "<id>"`): what the guard names. */
export const ContributionName = createContext<string | undefined>(undefined);
const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV !== false;

/**
 * THE React binding: one model group (getter + change channel) through `useSyncExternalStore`.
 * Contract point 7 (stable snapshot identity) is what makes it correct with no cache. In dev, the
 * first render reads the getter twice and throws a NAMED error if the two differ — before React's
 * "Maximum update depth exceeded" loop starts (the host's error boundary contains it). The error
 * names the contribution the host renders it for (`ContributionName`), and the getter if it has a
 * name of its own.
 */
export function useModel<T>(read: () => T, subscribe: (listener: () => void) => () => void): T {
  const where = useContext(ContributionName);
  const checked = useRef(!DEV);
  if (!checked.current) {
    checked.current = true;
    if (!Object.is(read(), read()))
      throw new Error(
        `${where ? `${where}: ` : ""}${read.name ? `getter ${read.name}` : "a getter"} returns a new value on every call (model contract point 7)`,
      );
  }
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

/**
 * A React renderer for `kind`, typed against the kind's model, as the heterogeneous renderer slot
 * stores it — the existential cast (P0 fail 9) lives here, once.
 */
export function reactRenderer<M>(
  kind: ViewKind<M>,
  component: ComponentType<{ model: M }>,
): ReactRenderer<never> {
  return { kind, component } as ReactRenderer<M> as unknown as ReactRenderer<never>;
}
