import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@statewalker/ui.view.shadcn";
import type { EditView } from "@todos/edit/model";
import { useModel } from "@ui/host";
import { ActionButton } from "@ui/sys/action";
import { Checkbox } from "../../sys/checkbox.js";

/** The editor: the saved todo above, the draft form below, Save and Cancel as actions. */
export function TodoEditPanel({ model }: { model: EditView }) {
  const todo = useModel(model.details.getTodo, model.details.onTodoUpdate);
  const draft = useModel(model.form.getDraft, model.form.onDraftUpdate);
  const status = useModel(model.form.getStatus, model.form.onStatusUpdate);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit todo</CardTitle>
        <CardDescription>
          {todo.title}
          {todo.done ? " · done" : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            model.form.actions.save.submit();
          }}
        >
          <Input
            aria-label="Title"
            value={draft.title}
            onChange={(event) => model.form.setTitle(event.target.value)}
          />
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox renders the <input> this label wraps */}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              aria-label="Done"
              checked={draft.done}
              onChange={(event) => model.form.setDone(event.target.checked)}
            />
            Done
          </label>
          {status.error !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              {status.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <ActionButton action={model.form.actions.cancel} variant="outline" />
            <ActionButton action={model.form.actions.save} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
