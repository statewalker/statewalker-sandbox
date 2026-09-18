/** Todos renderers: they show state and send messages. No logic, no kernel. */
import { ActionBar, ActionButton } from "../../kit/react/action-button.js";
import type { ViewProps } from "../shell/api/react.js";
import type {
  ClearCompletedMsg,
  ClearCompletedState,
  EditorMsg,
  EditorState,
  ListMsg,
  ListState,
} from "../todos/api/index.js";

export function ListView({ state, send, dispatch }: ViewProps<ListState, ListMsg>) {
  return (
    <div className="todos-list">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const add = state.toolbar.find((i) => i.action.id === "add");
          if (add) dispatch(add.action);
        }}
      >
        <input
          aria-label="New todo"
          value={state.newTitle}
          onChange={(e) => send({ type: "new-title", value: e.target.value })}
        />
      </form>
      <ActionBar label="Todo actions" items={state.toolbar} dispatch={dispatch} />
      <ul>
        {state.todos.map((t) => (
          <li
            key={t.id}
            data-todo={t.id}
            aria-current={state.selected.includes(t.id) ? "true" : undefined}
            onClick={(e) => send({ type: "select", id: t.id, additive: e.ctrlKey || e.metaKey })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ")
                send({ type: "select", id: t.id, additive: e.ctrlKey || e.metaKey });
            }}
          >
            <input
              type="checkbox"
              aria-label={`Done: ${t.title}`}
              checked={t.done}
              onClick={(e) => e.stopPropagation()}
              onChange={() => send({ type: "toggle-one", id: t.id })}
            />
            <span className={t.done ? "done" : undefined}>{t.title}</span>
          </li>
        ))}
      </ul>
      <ActionBar label="Selection actions" items={state.selectionActions} dispatch={dispatch} />
    </div>
  );
}

export function EditorView({ state, send, dispatch }: ViewProps<EditorState, EditorMsg>) {
  return (
    <form
      className="todos-editor"
      onSubmit={(e) => {
        e.preventDefault();
        dispatch(state.save);
      }}
    >
      <input
        aria-label="Title"
        value={state.title}
        onChange={(e) => send({ type: "edit", title: e.target.value })}
      />
      {state.error && <p data-error>{state.error}</p>}
      <ActionButton action={state.save} dispatch={dispatch} />
      <ActionButton action={state.cancel} dispatch={dispatch} />
    </form>
  );
}

export function ClearCompletedView({
  state,
  dispatch,
}: ViewProps<ClearCompletedState, ClearCompletedMsg>) {
  return (
    <div data-kind="todos:clear-completed">
      <p>
        Delete {state.count} completed todo{state.count === 1 ? "" : "s"}?
      </p>
      <ActionButton action={state.confirm} dispatch={dispatch} />
      <ActionButton action={state.cancel} dispatch={dispatch} />
    </div>
  );
}
