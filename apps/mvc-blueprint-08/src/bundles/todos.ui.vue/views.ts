import type { ConfirmView, TitleFormView, TodoListView } from "@b/todos/api";
import { ActionBar, ActionButton, modelProp, useModel } from "@kit/vue";
import { defineComponent, h } from "vue";

export const TodoList = defineComponent({
  props: { model: modelProp<TodoListView>() },
  setup({ model }) {
    const items = useModel(model.getItems, model.onItemsUpdate);
    const selection = useModel(model.getSelection, model.onSelectionUpdate);
    const newTitle = useModel(model.getNewTitle, model.onNewTitleUpdate);
    const toolbar = useModel(model.getToolbar, model.onToolbarUpdate);
    const selectionActions = useModel(model.getSelectionActions, model.onSelectionActionsUpdate);
    const outcome = useModel(model.getOutcome, model.onOutcomeUpdate);
    return () => {
      const sel = selection.value;
      return h("div", { class: "flex flex-col gap-3" }, [
        h("div", { class: "flex gap-2" }, [
          h("input", {
            "aria-label": "New todo",
            class: "flex-1 rounded border px-2",
            value: newTitle.value,
            onInput: (e: Event) => model.setNewTitle((e.target as HTMLInputElement).value),
          }),
          h(ActionBar, { items: toolbar.value, label: "Todo actions" }),
        ]),
        h(
          "ul",
          { "aria-label": "Todos", class: "flex flex-col" },
          items.value.map((todo) =>
            h(
              "li",
              {
                key: todo.id,
                "data-todo": todo.id,
                "aria-current": sel.includes(todo.id) || undefined,
                class: "flex items-center gap-2 px-2 py-1 aria-[current=true]:bg-slate-100",
                onClick: (e: MouseEvent) =>
                  model.select(
                    e.ctrlKey || e.metaKey
                      ? sel.includes(todo.id)
                        ? sel.filter((id) => id !== todo.id)
                        : [...sel, todo.id]
                      : [todo.id],
                  ),
              },
              [
                h("input", {
                  type: "checkbox",
                  "aria-label": `Done: ${todo.title}`,
                  checked: todo.done,
                  onClick: (e: MouseEvent) => {
                    e.stopPropagation();
                    // Controlled: the model decides; the DOM toggled itself already, so put it back.
                    (e.currentTarget as HTMLInputElement).checked = todo.done;
                    model.select([todo.id]);
                    model.toggle.submit();
                  },
                }),
                h("span", { class: todo.done ? "line-through" : undefined }, todo.title),
              ],
            ),
          ),
        ),
        h(ActionBar, { items: selectionActions.value, label: "Selection actions" }),
        outcome.value !== undefined ? h("p", { role: "alert" }, outcome.value) : null,
      ]);
    };
  },
});

export const TodoEditor = defineComponent({
  props: { model: modelProp<TitleFormView>() },
  setup({ model }) {
    const draft = useModel(model.getDraft, model.onDraftUpdate);
    const status = useModel(model.getStatus, model.onStatusUpdate);
    return () =>
      h(
        "form",
        {
          class: "flex flex-col gap-2",
          onSubmit: (e: Event) => {
            e.preventDefault();
            model.save.submit();
          },
        },
        [
          h("input", {
            "aria-label": "Title",
            class: "rounded border px-2",
            value: draft.value.title,
            onInput: (e: Event) => model.editField("title", (e.target as HTMLInputElement).value),
          }),
          status.value.errors.form ? h("p", { role: "alert" }, status.value.errors.form) : null,
          h("div", { class: "flex gap-2" }, [
            h(ActionButton, { action: model.save }),
            h(ActionButton, { action: model.cancel }),
          ]),
        ],
      );
  },
});

export const ClearCompletedDialog = defineComponent({
  props: { model: modelProp<ConfirmView>() },
  setup({ model }) {
    return () =>
      h("div", { class: "flex flex-col gap-2" }, [
        h("p", model.getQuestion().text),
        h("div", { class: "flex gap-2" }, [
          h(ActionButton, { action: model.confirm }),
          h(ActionButton, { action: model.cancel }),
        ]),
      ]);
  },
});
