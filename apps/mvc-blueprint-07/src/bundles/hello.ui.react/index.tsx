import type { Controller } from "../../kernel/context.js";
import { getSlots } from "../../kernel/slots.js";
import { ActionButton } from "../../kit/react/action-button.js";
import { useModel } from "../../kit/react/use-model.js";
import { type HelloView, helloKind } from "../hello/api/index.js";
import { reactRenderer, reactRenderersSlot } from "../shell/api/react.js";

function Hello({ model }: { model: HelloView }) {
  const { count } = useModel(model.getState, model.onStateUpdate);
  return (
    <p>
      Count: <output>{count}</output> <ActionButton action={model.increment} />
    </p>
  );
}

export const activate: Controller = async (context) =>
  getSlots(context).register(reactRenderersSlot, helloKind.id, reactRenderer(helloKind, Hello));
