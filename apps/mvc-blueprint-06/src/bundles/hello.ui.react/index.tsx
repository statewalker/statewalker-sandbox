/** The minimal bundle's React renderer. Kernel only (no kit). */
import { type BundleManifest, contribute } from "../../kernel/index.js";
import { type HelloState, helloKind } from "../hello/api/index.js";
import { reactRenderers, type ViewProps } from "../shell/api/react.js";

function HelloView({ state, dispatch }: ViewProps<HelloState, never>) {
  return (
    <p>
      Count: <output>{state.count}</output>{" "}
      <button type="button" onClick={() => dispatch(state.increment)}>
        {state.increment.label}
      </button>
    </p>
  );
}

export const helloUiReactBundle: BundleManifest = {
  id: "hello.ui.react",
  behavior: (ctx) => {
    contribute(ctx, reactRenderers, helloKind.id, { kind: helloKind.id, component: HelloView });
    return () => {};
  },
};
