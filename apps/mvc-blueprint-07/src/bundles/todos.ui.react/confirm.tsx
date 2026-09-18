import { ActionButton } from "../../kit/react/action-button.js";
import { useModel } from "../../kit/react/use-model.js";
import type { ClearCompletedView } from "../todos/api/index.js";

export function ClearCompletedConfirm({ model }: { model: ClearCompletedView }) {
  const { count } = useModel(model.getState, model.onStateUpdate);
  return (
    <div>
      <p>
        Remove {count} completed todo{count === 1 ? "" : "s"}?
      </p>
      <ActionButton action={model.confirm} />
      <ActionButton action={model.cancel} />
    </div>
  );
}
