import type { HelloView } from "@b/hello/api";
import { ActionButton, useModel } from "@kit/react";

export function Hello({ model }: { model: HelloView }) {
  const count = useModel(model.getCount, model.onCountUpdate);
  return (
    <div className="flex items-center gap-3">
      <p data-hello-count>Count: {count}</p>
      <ActionButton action={model.increment} />
    </div>
  );
}
