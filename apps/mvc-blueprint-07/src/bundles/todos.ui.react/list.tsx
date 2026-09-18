import { ActionButton } from "../../kit/react/action-button.js";
import { useModel } from "../../kit/react/use-model.js";
import type { TodosListView } from "../todos/api/index.js";

export function TodoList({ model }: { model: TodosListView }) {
  const items = useModel(model.getItems, model.onItemsUpdate);
  const newTitle = useModel(model.getNewTitle, model.onNewTitleUpdate);
  const toolbar = useModel(model.getToolbar, model.onToolbarUpdate);
  const actions = useModel(model.getSelectionActions, model.onSelectionActionsUpdate);
  return (
    <div className="todos">
      <div role="toolbar" aria-label="Todos toolbar">
        <input
          aria-label="New todo title"
          value={newTitle}
          onChange={(e) => model.editNewTitle(e.target.value)}
        />
        {toolbar.map((entry) => (
          <ActionButton key={entry.id} action={entry.action} />
        ))}
      </div>
      <ul aria-label="Todos">
        {items.map((todo) => (
          <li key={todo.id} aria-current={todo.selected || undefined} data-id={todo.id}>
            <input
              type="checkbox"
              aria-label={`Done: ${todo.title}`}
              checked={todo.done}
              onChange={() => model.toggle(todo.id)}
            />
            <button
              type="button"
              className="row"
              onClick={(e) => model.select(todo.id, e.ctrlKey || e.metaKey)}
            >
              {todo.title}
            </button>
          </li>
        ))}
      </ul>
      <div role="toolbar" aria-label="Selection actions">
        {actions.map((entry) => (
          <ActionButton key={entry.id} action={entry.action} />
        ))}
      </div>
    </div>
  );
}
