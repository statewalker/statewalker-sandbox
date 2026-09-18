import { ActionButton } from "../../kit/react/action-button.js";
import { useModel } from "../../kit/react/use-model.js";
import type { RenameView } from "../todos/api/index.js";

export function RenameDialog({ model }: { model: RenameView }) {
  const draft = useModel(model.getDraft, model.onDraftUpdate);
  const status = useModel(model.getStatus, model.onStatusUpdate);
  return (
    <div>
      <input
        aria-label="New title"
        value={draft.title}
        onChange={(e) => model.editTitle(e.target.value)}
      />
      {status.error && <p role="alert">{status.error}</p>}
      <ActionButton action={model.rename} />
      <ActionButton action={model.cancel} />
    </div>
  );
}
