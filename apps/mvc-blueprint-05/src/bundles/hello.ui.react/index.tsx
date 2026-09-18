/** hello.ui.react — the renderer of the minimal bundle. */
import { type Activator, getStore } from "../../kernel/index.ts";
import { helloKind } from "../hello/api/index.ts";
import { reactRenderers, renderer } from "../shell/api/react.ts";

const Hello = renderer(helloKind, ({ props, dispatch }) => (
  <p>
    Count: <output>{props.count}</output>{" "}
    <button type="button" onClick={() => dispatch(props.increment.msg)}>
      {props.increment.label}
    </button>
  </p>
));

export const activate: Activator = async (context) =>
  getStore(context).contribute(reactRenderers, helloKind.id, () => [Hello]);
