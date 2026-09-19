import type { ViewSpec } from "@b/shell/api/spec";
import type { ConfirmView, TitleFormView, TodoListView } from "@b/todos/api";

/**
 * The Todos views as data: JSON, typed against each kind's view model so a misspelt group,
 * intent or action fails `tsc` (the interpreters check the same names at mount).
 */

export const todoListSpec: ViewSpec<TodoListView> = {
  root: {
    el: "div",
    attrs: { class: "flex flex-col gap-3" },
    children: [
      {
        el: "div",
        attrs: { class: "flex gap-2" },
        children: [
          {
            el: "input",
            attrs: {
              "aria-label": "New todo",
              class: "flex-1 rounded border px-2",
              value: { read: "newTitle" },
            },
            on: { input: { intent: "setNewTitle", args: [{ event: "value" }] } },
          },
          { actions: "toolbar", label: "Todo actions" },
        ],
      },
      {
        el: "ul",
        attrs: { "aria-label": "Todos", class: "flex flex-col" },
        children: [
          {
            each: { read: "items" },
            children: [
              {
                el: "li",
                attrs: {
                  "data-todo": { item: "id" },
                  "aria-current": {
                    if: [{ includes: [{ read: "selection" }, { item: "id" }] }, "true"],
                  },
                  class: "flex items-center gap-2 px-2 py-1 aria-[current=true]:bg-slate-100",
                },
                on: {
                  // Ctrl/Meta-click extends the selection; a plain click selects one.
                  click: {
                    intent: "select",
                    args: [
                      {
                        if: [
                          { event: "extend" },
                          { toggle: [{ read: "selection" }, { item: "id" }] },
                          [{ item: "id" }],
                        ],
                      },
                    ],
                  },
                },
                children: [
                  {
                    el: "input",
                    attrs: {
                      type: "checkbox",
                      "aria-label": { concat: ["Done: ", { item: "title" }] },
                      checked: { item: "done" },
                    },
                    // One gesture, one tick: select this row, then toggle (TodoListView.toggle).
                    on: {
                      change: [
                        { intent: "select", args: [[{ item: "id" }]] },
                        { submit: "toggle" },
                      ],
                    },
                  },
                  {
                    el: "span",
                    attrs: { class: { if: [{ item: "done" }, "line-through"] } },
                    children: [{ text: { item: "title" } }],
                  },
                ],
              },
            ],
          },
        ],
      },
      { actions: "selectionActions", label: "Selection actions" },
      {
        when: { read: "outcome" },
        children: [
          { el: "p", attrs: { role: "alert" }, children: [{ text: { read: "outcome" } }] },
        ],
      },
    ],
  },
};

/** The editor and the rename dialog: one title field, Save/Rename and Cancel. */
export const titleFormSpec: ViewSpec<TitleFormView> = {
  root: {
    el: "form",
    attrs: { class: "flex flex-col gap-2" },
    on: { submit: { submit: "save" } },
    children: [
      {
        el: "input",
        attrs: {
          "aria-label": "Title",
          class: "rounded border px-2",
          value: { read: "draft.title" },
        },
        on: { input: { intent: "editField", args: ["title", { event: "value" }] } },
      },
      {
        when: { read: "status.errors.form" },
        children: [
          {
            el: "p",
            attrs: { role: "alert" },
            children: [{ text: { read: "status.errors.form" } }],
          },
        ],
      },
      {
        el: "div",
        attrs: { class: "flex gap-2" },
        children: [{ action: "save" }, { action: "cancel" }],
      },
    ],
  },
};

export const clearCompletedSpec: ViewSpec<ConfirmView> = {
  root: {
    el: "div",
    attrs: { class: "flex flex-col gap-2" },
    children: [
      { el: "p", children: [{ text: { read: "question.text" } }] },
      {
        el: "div",
        attrs: { class: "flex gap-2" },
        children: [{ action: "confirm" }, { action: "cancel" }],
      },
    ],
  },
};
