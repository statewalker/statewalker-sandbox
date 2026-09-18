import type { ActionContribution, ActionView } from "@kernel";
import {
  defineComponent,
  h,
  onScopeDispose,
  type PropType,
  type ShallowRef,
  shallowRef,
} from "vue";

/**
 * THE Vue binding: one model group as a shallow ref. `shallowRef` skips a write that is
 * `Object.is`-equal, so contract point 7 (stable snapshot identity) is what keeps a no-op
 * notification from re-rendering; no deep proxy is made of a frozen snapshot. Vue re-renders on its
 * next tick after our synchronous notification (tests: `await nextTick()`).
 * Call it in `setup()` (or any effect scope): the subscription ends with the scope.
 */
export function useModel<T>(
  read: () => T,
  subscribe: (listener: () => void) => () => void,
): Readonly<ShallowRef<T>> {
  const value = shallowRef(read()) as ShallowRef<T>;
  onScopeDispose(
    subscribe(() => {
      value.value = read();
    }),
  );
  return value;
}

const keys = new WeakMap<object, number>();
let nextKey = 0;
/**
 * A vnode key per object identity. Components here read their model once, in `setup()`; keying by
 * the model makes Vue re-create (not patch) a component whose model was replaced under the same id.
 */
export function identityKey(o: object): number {
  let k = keys.get(o);
  if (k === undefined) {
    k = nextKey++;
    keys.set(o, k);
  }
  return k;
}

/** A view-model prop, typed. Read once in `setup()`; the parent keys the component by it. */
export const modelProp = <M>() => ({ type: Object as PropType<M>, required: true as const });

/** Any action as a button: label, hint; disabled while not enabled or running. */
export const ActionButton = defineComponent({
  props: { action: modelProp<ActionView>(), class: String },
  setup(props) {
    const state = useModel(props.action.getState, props.action.onStateUpdate);
    return () =>
      h(
        "button",
        {
          type: "button",
          class: props.class ?? "rounded border px-3 py-1 text-sm disabled:opacity-50",
          title: state.value.hint,
          "aria-busy": String(state.value.running),
          disabled: !state.value.enabled || state.value.running,
          onClick: () => props.action.submit(),
        },
        state.value.label,
      );
  },
});

/** A list of contributed actions as a toolbar. */
export const ActionBar = defineComponent({
  props: {
    items: { type: Array as PropType<readonly ActionContribution[]>, required: true },
    label: { type: String, required: true },
  },
  setup(props) {
    return () =>
      h(
        "div",
        { role: "toolbar", "aria-label": props.label, class: "flex flex-wrap gap-2" },
        props.items.map((c) => h(ActionButton, { key: identityKey(c.action), action: c.action })),
      );
  },
});
