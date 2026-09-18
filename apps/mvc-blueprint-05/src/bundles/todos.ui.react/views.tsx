/** Todos renderers: plain data in, messages out. No logic beyond rendering choices. */
import type { ActionItem, Dispatch } from "../../kernel/index.ts";
import type { RendererProps } from "../shell/api/react.ts";
import {
  type ClearCompletedProps,
  type TodoEditorProps,
  type TodosListProps,
  todoEditorIntents,
  todosListIntents,
} from "../todos/api/index.ts";

const Action = ({ item, dispatch }: { item: ActionItem; dispatch: Dispatch }) => (
  <button
    type="button"
    disabled={!item.enabled}
    aria-busy={item.running || undefined}
    className="rounded border px-2 py-1 disabled:opacity-50"
    onClick={() => dispatch(item.msg)}
  >
    {item.label}
  </button>
);

export function TodosList({ props, dispatch }: RendererProps<TodosListProps>) {
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const add = props.toolbar.find((a) => a.id === "add");
          if (add?.enabled) dispatch(add.msg);
        }}
      >
        <input
          aria-label="New todo title"
          className="flex-1 rounded border px-2 py-1"
          value={props.newTitle}
          onChange={(e) => dispatch(todosListIntents.newTitle({ title: e.target.value }))}
        />
        {props.toolbar.map((a) => (
          <Action key={a.id} item={a} dispatch={dispatch} />
        ))}
      </form>
      <ul aria-label="Todos" className="flex flex-col">
        {props.rows.map((row) => (
          <li
            key={row.id}
            aria-current={row.selected || undefined}
            className="flex items-center gap-2 px-1 aria-[current]:bg-accent"
          >
            <input
              type="checkbox"
              aria-label={`Done: ${row.title}`}
              checked={row.done}
              onChange={() => dispatch(todosListIntents.toggle({ id: row.id }))}
            />
            <button
              type="button"
              className={row.done ? "line-through text-muted-foreground" : ""}
              onClick={(e) =>
                dispatch(todosListIntents.click({ id: row.id, additive: e.ctrlKey || e.metaKey }))
              }
            >
              {row.title}
            </button>
          </li>
        ))}
      </ul>
      <div role="toolbar" aria-label="Selection actions" className="flex gap-2">
        {props.selectionActions.map((a) => (
          <Action key={a.id} item={a} dispatch={dispatch} />
        ))}
      </div>
    </div>
  );
}

export function TodoEditor({ props, dispatch }: RendererProps<TodoEditorProps>) {
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (props.save.enabled) dispatch(props.save.msg);
      }}
    >
      <input
        aria-label="Title"
        className="rounded border px-2 py-1"
        value={props.title}
        onChange={(e) => dispatch(todoEditorIntents.title({ title: e.target.value }))}
      />
      {props.error && (
        <p role="alert" className="text-destructive">
          {props.error}
        </p>
      )}
      <div className="flex gap-2">
        <Action item={props.save} dispatch={dispatch} />
        <Action item={props.cancel} dispatch={dispatch} />
      </div>
    </form>
  );
}

export function ClearCompleted({ props, dispatch }: RendererProps<ClearCompletedProps>) {
  return (
    <div className="flex flex-col gap-3">
      <p>
        Remove {props.count} completed {props.count === 1 ? "todo" : "todos"}?
      </p>
      <div className="flex gap-2">
        <Action item={props.confirm} dispatch={dispatch} />
        <Action item={props.cancel} dispatch={dispatch} />
      </div>
    </div>
  );
}
