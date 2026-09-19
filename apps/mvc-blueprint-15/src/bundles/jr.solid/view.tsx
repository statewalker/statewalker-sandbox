/** @jsxImportSource solid-js */
import type { JrView } from "@b/shell/api/jr";
import { JSONUIProvider, Renderer } from "@json-render/solid";
import { functions, modelStore } from "@kit/jr";
import type { Component } from "solid-js";
import { registry } from "./catalog.js";

/**
 * One json-render view as a Solid renderer. Setup runs once per model: the Solid host already
 * re-creates a renderer when its contribution's model changes identity (U1's `<Show keyed>`).
 */
export function jrComponent<M>(
  view: JrView<M>,
  refuse: (message: string) => void,
): Component<{ model: M }> {
  return (props) => {
    const store = modelStore(view.bind(props.model), refuse);
    return (
      <JSONUIProvider
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
