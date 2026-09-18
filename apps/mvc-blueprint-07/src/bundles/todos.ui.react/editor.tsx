import { ActionButton } from "../../kit/react/action-button.js";
import { useModel } from "../../kit/react/use-model.js";
import type { TodoEditorView } from "../todos/api/index.js";

export function TodoEditor({ model }: { model: TodoEditorView }) {
  const draft = useModel(model.getDraft, model.onDraftUpdate);
  const status = useModel(model.getStatus, model.onStatusUpdate);
  return (
    <div className="editor">
      <input
        aria-label="Title"
        value={draft.title}
        onChange={(e) => model.editTitle(e.target.value)}
      />
      {status.error && <p role="alert">{status.error}</p>}
      <ActionButton action={model.save} />
      <ActionButton action={model.cancel} />
    </div>
  );
}
