/** @jsxImportSource solid-js */
import type { HelloView } from "@p5/hello/api";
import { ActionButton, useModel } from "@p5/kit-solid";

export function Hello(props: { model: HelloView }) {
  const count = useModel(props.model.getCount, props.model.onCountUpdate);
  return (
    <div class="flex items-center gap-3">
      <p data-hello-count>Count: {count()}</p>
      <ActionButton action={props.model.increment} />
    </div>
  );
}
