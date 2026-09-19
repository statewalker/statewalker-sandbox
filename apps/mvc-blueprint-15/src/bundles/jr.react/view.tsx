import type { JrView } from "@b/shell/api/jr";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { functions, modelStore } from "@kit/jr";
import { type ComponentType, useMemo } from "react";
import { registry } from "./catalog.js";

/** One json-render view as a React renderer: the adapter over the model, the providers, the spec. */
export function jrComponent<M>(
  view: JrView<M>,
  refuse: (message: string) => void,
): ComponentType<{ model: M }> {
  return function JrRenderer({ model }) {
    // A new model is a new store: the provider cannot switch stores, so the subtree is keyed too.
    const store = useMemo(() => modelStore(view.bind(model), refuse), [model]);
    return (
      <JSONUIProvider
        key={keyOf(model)}
        registry={registry}
        store={store.state}
        handlers={store.handlers}
        functions={functions}
      >
        <Renderer spec={view.spec} registry={registry} />
      </JSONUIProvider>
    );
  };
}

const keys = new WeakMap<object, number>();
let next = 0;
const keyOf = (model: unknown) => {
  const o = model as object;
  if (!keys.has(o)) keys.set(o, ++next);
  return keys.get(o);
};
