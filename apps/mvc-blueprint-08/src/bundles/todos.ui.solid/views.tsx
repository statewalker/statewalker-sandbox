import type { ConfirmView, TitleFormView, TodoListView } from "@b/todos/api";
import { ActionBar, ActionButton, useModel } from "@kit/solid";
import { For, Show } from "solid-js";

export function TodoList(props: { model: TodoListView }) {
  const model = props.model;
  const items = useModel(model.getItems, model.onItemsUpdate);
  const selection = useModel(model.getSelection, model.onSelectionUpdate);
  const newTitle = useModel(model.getNewTitle, model.onNewTitleUpdate);
  const toolbar = useModel(model.getToolbar, model.onToolbarUpdate);
  const selectionActions = useModel(model.getSelectionActions, model.onSelectionActionsUpdate);
  const outcome = useModel(model.getOutcome, model.onOutcomeUpdate);
  return (
    <div class="flex flex-col gap-3">
      <div class="flex gap-2">
        <input
          aria-label="New todo"
          class="flex-1 rounded border px-2"
          value={newTitle()}
          onInput={(e) => model.setNewTitle(e.currentTarget.value)}
        />
        <ActionBar items={toolbar()} label="Todo actions" />
      </div>
      <ul aria-label="Todos" class="flex flex-col">
        <For each={items()}>
          {(todo) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: row selection; the checkbox is the keyboard path
            <li
              data-todo={todo.id}
              aria-current={selection().includes(todo.id) || undefined}
              class="flex items-center gap-2 px-2 py-1 aria-[current=true]:bg-slate-100"
              onClick={(e) =>
                model.select(
                  e.ctrlKey || e.metaKey
                    ? selection().includes(todo.id)
                      ? selection().filter((id) => id !== todo.id)
                      : [...selection(), todo.id]
                    : [todo.id],
                )
              }
            >
              <input
                type="checkbox"
                aria-label={`Done: ${todo.title}`}
                checked={todo.done}
                onClick={(e) => {
                  e.stopPropagation();
                  // Controlled: the model decides; the DOM toggled itself already, so put it back.
                  e.currentTarget.checked = todo.done;
                  model.select([todo.id]);
                  model.toggle.submit();
                }}
              />
              <span class={todo.done ? "line-through" : undefined}>{todo.title}</span>
            </li>
          )}
        </For>
      </ul>
      <ActionBar items={selectionActions()} label="Selection actions" />
      <Show when={outcome() !== undefined}>
        <p role="alert">{outcome()}</p>
      </Show>
    </div>
  );
}

export function TodoEditor(props: { model: TitleFormView }) {
  const model = props.model;
  const draft = useModel(model.getDraft, model.onDraftUpdate);
  const status = useModel(model.getStatus, model.onStatusUpdate);
  return (
    <form
      class="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        model.save.submit();
      }}
    >
      <input
        aria-label="Title"
        class="rounded border px-2"
        value={draft().title}
        onInput={(e) => model.editField("title", e.currentTarget.value)}
      />
      <Show when={status().errors.form}>
        <p role="alert">{status().errors.form}</p>
      </Show>
      <div class="flex gap-2">
        <ActionButton action={model.save} />
        <ActionButton action={model.cancel} />
      </div>
    </form>
  );
}

export function ClearCompletedDialog(props: { model: ConfirmView }) {
  return (
    <div class="flex flex-col gap-2">
      <p>{props.model.getQuestion().text}</p>
      <div class="flex gap-2">
        <ActionButton action={props.model.confirm} />
        <ActionButton action={props.model.cancel} />
      </div>
    </div>
  );
}
