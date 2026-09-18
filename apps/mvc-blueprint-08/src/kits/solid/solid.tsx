import type { ActionContribution, ActionView } from "@kernel";
import { type Accessor, createSignal, For, onCleanup } from "solid-js";

/**
 * THE Solid binding: one model group as an accessor. The signal's default `===` equality plus
 * contract point 7 (a snapshot keeps its identity until its value changes) makes a notification
 * that changed nothing a no-op; point 1 (immediate callback) makes the initial read redundant but
 * harmless. Solid writes the DOM synchronously in the setter: nothing to flush.
 * Call it inside a component (or any owner): the subscription ends with the owner.
 */
export function useModel<T>(
  read: () => T,
  subscribe: (listener: () => void) => () => void,
): Accessor<T> {
  const [value, setValue] = createSignal<T>(read());
  onCleanup(subscribe(() => setValue(() => read())));
  return value;
}

/** Any action as a button: label, hint; disabled while not enabled or running. */
export function ActionButton(props: { action: ActionView; class?: string }) {
  const state = useModel(props.action.getState, props.action.onStateUpdate);
  return (
    <button
      type="button"
      class={props.class ?? "rounded border px-3 py-1 text-sm disabled:opacity-50"}
      title={state().hint}
      aria-busy={state().running}
      disabled={!state().enabled || state().running}
      onClick={() => props.action.submit()}
    >
      {state().label}
    </button>
  );
}

/** A list of contributed actions as a toolbar. */
export function ActionBar(props: { items: readonly ActionContribution[]; label: string }) {
  return (
    <div role="toolbar" aria-label={props.label} class="flex flex-wrap gap-2">
      <For each={props.items}>{(c) => <ActionButton action={c.action} />}</For>
    </div>
  );
}
