/** @jsxImportSource solid-js */
import type { ActionContribution, ActionView, ViewKind } from "@p5/kernel";
import type { SolidRenderer } from "@p5/shell/api/solid";
import { type Accessor, type Component, createSignal, For, onCleanup } from "solid-js";

/**
 * THE Solid binding (U1): one model group as an accessor. The signal's default `===` equality plus
 * contract point 7 (a snapshot keeps its identity until its value changes) makes a notification
 * that changed nothing a no-op. Solid writes the DOM synchronously in the setter: nothing to flush.
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

/**
 * A Solid renderer for `kind`, typed against the kind's model, as the heterogeneous renderer slot
 * stores it — the existential cast (P0 fail 9) lives here, once.
 */
export function solidRenderer<M>(
  kind: ViewKind<M>,
  component: Component<{ model: M }>,
): SolidRenderer<never> {
  return { kind, component } as SolidRenderer<M> as unknown as SolidRenderer<never>;
}
