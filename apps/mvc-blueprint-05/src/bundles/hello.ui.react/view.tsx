import { helloKind } from "../hello/api/index.ts";
import { renderer } from "../shell/api/react.ts";

export const Hello = renderer(helloKind, ({ props, dispatch }) => (
  <p>
    Count: <output>{props.count}</output>{" "}
    <button type="button" onClick={() => dispatch(props.increment.msg)}>
      {props.increment.label}
    </button>
  </p>
));
