import type { ConfirmView, TitleFormView, TodoListView } from "@p5/todos/api";
import { ActionBar, ActionButton, useModel } from "@p5/kit-react";

export function TodoList({ model }: { model: TodoListView }) {
  const items = useModel(model.getItems, model.onItemsUpdate);
  const selection = useModel(model.getSelection, model.onSelectionUpdate);
  const newTitle = useModel(model.getNewTitle, model.onNewTitleUpdate);
  const toolbar = useModel(model.getToolbar, model.onToolbarUpdate);
  const selectionActions = useModel(model.getSelectionActions, model.onSelectionActionsUpdate);
  const outcome = useModel(model.getOutcome, model.onOutcomeUpdate);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input
          aria-label="New todo"
          className="flex-1 rounded border px-2"
          value={newTitle}
          onChange={(e) => model.setNewTitle(e.target.value)}
        />
        <ActionBar items={toolbar} label="Todo actions" />
      </div>
      <ul aria-label="Todos" className="flex flex-col">
        {items.map((todo) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: row selection; the checkbox is the keyboard path
          <li
            key={todo.id}
            data-todo={todo.id}
            aria-current={selection.includes(todo.id) || undefined}
            className="flex items-center gap-2 px-2 py-1 aria-[current=true]:bg-slate-100"
            onClick={(e) =>
              model.select(
                e.ctrlKey || e.metaKey
                  ? selection.includes(todo.id)
                    ? selection.filter((id) => id !== todo.id)
                    : [...selection, todo.id]
                  : [todo.id],
              )
            }
          >
            <input
              type="checkbox"
              aria-label={`Done: ${todo.title}`}
              checked={todo.done}
              onClick={(e) => e.stopPropagation()}
              onChange={() => {
                model.select([todo.id]);
                model.toggle.submit();
              }}
            />
            <span className={todo.done ? "line-through" : undefined}>{todo.title}</span>
          </li>
        ))}
      </ul>
      <ActionBar items={selectionActions} label="Selection actions" />
      {outcome !== undefined && <p role="alert">{outcome}</p>}
    </div>
  );
}

export function TodoEditor({ model }: { model: TitleFormView }) {
  const draft = useModel(model.getDraft, model.onDraftUpdate);
  const status = useModel(model.getStatus, model.onStatusUpdate);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        model.save.submit();
      }}
    >
      <input
        aria-label="Title"
        className="rounded border px-2"
        value={draft.title}
        onChange={(e) => model.editField("title", e.target.value)}
      />
      {status.errors.form && <p role="alert">{status.errors.form}</p>}
      <div className="flex gap-2">
        <ActionButton action={model.save} />
        <ActionButton action={model.cancel} />
      </div>
    </form>
  );
}

export function ClearCompletedDialog({ model }: { model: ConfirmView }) {
  return (
    <div className="flex flex-col gap-2">
      <p>{model.getQuestion().text}</p>
      <div className="flex gap-2">
        <ActionButton action={model.confirm} />
        <ActionButton action={model.cancel} />
      </div>
    </div>
  );
}
