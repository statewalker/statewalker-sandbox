import type { ConfirmView, TitleFormView, TodoListView } from "@b/todos/api";
import { actionBar, actionButton, bind, h, newScope, setValue } from "@kit/dom";

export function mountTodoList(host: HTMLElement, model: TodoListView): () => void {
  const scope = newScope();
  const input = h("input", {
    "aria-label": "New todo",
    class: "flex-1 rounded border px-2",
    oninput: (e) => model.setNewTitle((e.target as HTMLInputElement).value),
  });
  const toolbar = actionBar(model.getToolbar, model.onToolbarUpdate, "Todo actions");
  const list = h("ul", { "aria-label": "Todos", class: "flex flex-col" });
  const selectionBar = actionBar(
    model.getSelectionActions,
    model.onSelectionActionsUpdate,
    "Selection actions",
  );
  const outcome = h("p", { role: "alert" });
  scope.own(toolbar.dispose);
  scope.own(selectionBar.dispose);
  host.append(
    h(
      "div",
      { class: "flex flex-col gap-3" },
      h("div", { class: "flex gap-2" }, input, toolbar.el),
      list,
      selectionBar.el,
      outcome,
    ),
  );

  const renderRows = () => {
    const selection = model.getSelection();
    list.replaceChildren(
      ...model.getItems().map((todo) => {
        const box = h("input", {
          type: "checkbox",
          "aria-label": `Done: ${todo.title}`,
          onclick: (e) => e.stopPropagation(),
          onchange: () => {
            model.select([todo.id]);
            model.toggle.submit();
          },
        });
        box.checked = todo.done;
        const row = h(
          "li",
          {
            "data-todo": todo.id,
            "aria-current": selection.includes(todo.id) ? "true" : undefined,
            class: "flex items-center gap-2 px-2 py-1 aria-[current=true]:bg-slate-100",
            onclick: (e) => {
              const extend = (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey;
              const current = model.getSelection();
              model.select(
                !extend
                  ? [todo.id]
                  : current.includes(todo.id)
                    ? current.filter((id) => id !== todo.id)
                    : [...current, todo.id],
              );
            },
          },
          box,
          h("span", { class: todo.done ? "line-through" : undefined }, todo.title),
        );
        return row;
      }),
    );
  };
  scope.own(bind(model.getItems, model.onItemsUpdate, renderRows));
  scope.own(bind(model.getSelection, model.onSelectionUpdate, renderRows));
  scope.own(bind(model.getNewTitle, model.onNewTitleUpdate, (v) => setValue(input, v)));
  scope.own(
    bind(model.getOutcome, model.onOutcomeUpdate, (v) => {
      outcome.hidden = v === undefined;
      outcome.textContent = v ?? "";
    }),
  );
  return () => {
    scope.dispose();
    host.replaceChildren();
  };
}

export function mountTodoEditor(host: HTMLElement, model: TitleFormView): () => void {
  const scope = newScope();
  const input = h("input", {
    "aria-label": "Title",
    class: "rounded border px-2",
    oninput: (e) => model.editField("title", (e.target as HTMLInputElement).value),
  });
  const error = h("p", { role: "alert" });
  const save = actionButton(model.save);
  const cancel = actionButton(model.cancel);
  scope.own(save.dispose);
  scope.own(cancel.dispose);
  const form = h(
    "form",
    {
      class: "flex flex-col gap-2",
      onsubmit: (e) => {
        e.preventDefault();
        model.save.submit();
      },
    },
    input,
    error,
    h("div", { class: "flex gap-2" }, save.el, cancel.el),
  );
  host.append(form);
  scope.own(bind(model.getDraft, model.onDraftUpdate, (d) => setValue(input, d.title)));
  scope.own(
    bind(model.getStatus, model.onStatusUpdate, (s) => {
      error.hidden = !s.errors.form;
      error.textContent = s.errors.form ?? "";
    }),
  );
  return () => {
    scope.dispose();
    host.replaceChildren();
  };
}

export function mountClearCompleted(host: HTMLElement, model: ConfirmView): () => void {
  const confirm = actionButton(model.confirm);
  const cancel = actionButton(model.cancel);
  host.append(
    h(
      "div",
      { class: "flex flex-col gap-2" },
      h("p", {}, model.getQuestion().text),
      h("div", { class: "flex gap-2" }, confirm.el, cancel.el),
    ),
  );
  return () => {
    confirm.dispose();
    cancel.dispose();
    host.replaceChildren();
  };
}
