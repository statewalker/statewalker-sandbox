import { type Controller, useFields } from "../../kernel/context.js";
import { defineEvent, isIntent, openLog } from "../../kernel/log.js";
import type { ActionView } from "../../kernel/models.js";
import { getSlots } from "../../kernel/slots.js";
import { intentAction } from "../../kit/action.js";
import { cell, derived } from "../../kit/cell.js";
import { followList, followSlot } from "../../kit/follow.js";
import { menuSlot, panelsSlot } from "../shell/api/index.js";
import {
  addTodo,
  collectionSlot,
  compose,
  removeTodos,
  selectionActionsSlot,
  selectionSlot,
  type Todo,
  type TodoItem,
  type TodosListView,
  type TodosSelectionView,
  todosListKind,
  toolbarActionsSlot,
  updateTodo,
} from "../todos/api/index.js";

/** Private event: a selection gesture. The selection is a fold of these; no one answers them. */
const selected = defineEvent<{ id: string; additive: boolean }>("todos.list:select");

const fields = useFields({ slots: getSlots });

export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const log = openLog(context, "todos.list");
  const cleanups: Array<() => void> = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    cleanups.push(() => x.dispose());
    return x;
  };

  const todos = own(
    followSlot(
      slots,
      collectionSlot,
      (c) => ({ get: c.getTodos, subscribe: c.onTodosUpdate }),
      [] as readonly Todo[],
    ),
  );

  // Selection: a projection of the select events, intersected with the todos that still exist.
  const picked = own(cell<readonly string[]>([]));
  cleanups.push(
    log.project((record) => {
      if (!isIntent(record, selected)) return;
      const { id, additive } = record.payload;
      const now = picked.get();
      if (!additive) picked.set([id]);
      else picked.set(now.includes(id) ? now.filter((x) => x !== id) : [...now, id]);
    }),
  );
  const selection = own(
    derived([picked, todos], () => {
      const exists = new Set(todos.get().map((t) => t.id));
      return picked.get().filter((id) => exists.has(id));
    }),
  );
  const selectionView: TodosSelectionView = Object.freeze({
    getSelected: selection.get,
    onSelectedUpdate: selection.subscribe,
  });
  cleanups.push(slots.provide(selectionSlot, selectionView));

  const items = own(
    derived([todos, selection], () => {
      const sel = new Set(selection.get());
      return todos.get().map((t): TodoItem => ({ ...t, selected: sel.has(t.id) }));
    }),
  );
  const newTitle = own(cell(""));

  // Actions: each submit appends an intent whose payload is captured at submit time.
  const add = own(
    intentAction(log, {
      label: "Add",
      whileRunning: "append",
      guard: own(derived([newTitle], () => newTitle.get().trim() !== "")),
      commit: () => {
        const record = log.append(addTodo, { title: newTitle.get().trim() });
        newTitle.set(""); // the whole input reset after its commit
        return record;
      },
    }),
  );
  const someSelected = own(derived([selection], () => selection.get().length > 0));
  const toggle = own(
    intentAction(log, {
      label: "Toggle",
      whileRunning: "append",
      guard: someSelected,
      commit: () =>
        todos
          .get()
          .filter((t) => selection.get().includes(t.id))
          .map((t) => log.append(updateTodo, { id: t.id, patch: { done: !t.done } })),
    }),
  );
  const remove = own(
    intentAction(log, {
      label: "Delete",
      guard: someSelected,
      commit: () => log.append(removeTodos, { ids: selection.get() }),
    }),
  );
  const newTodo = own(
    intentAction(log, { label: "New todo…", commit: () => log.append(compose, { title: "" }) }),
  );
  const entry = (id: string, order: number, action: ActionView) => ({ id, order, action });
  cleanups.push(
    slots.provide(toolbarActionsSlot, entry("add", 0, add.view)),
    slots.provide(selectionActionsSlot, entry("toggle", 10, toggle.view)),
    slots.provide(selectionActionsSlot, entry("delete", 30, remove.view)),
    slots.provide(menuSlot, {
      id: "todos.new",
      group: "todos",
      groupLabel: "Todos",
      order: 0,
      action: newTodo.view,
    }),
  );

  const toolbar = own(followList(slots, toolbarActionsSlot));
  const selectionActions = own(followList(slots, selectionActionsSlot));
  const model: TodosListView = Object.freeze({
    getItems: items.get,
    onItemsUpdate: items.subscribe,
    getNewTitle: newTitle.get,
    onNewTitleUpdate: newTitle.subscribe,
    getToolbar: toolbar.get,
    onToolbarUpdate: toolbar.subscribe,
    getSelectionActions: selectionActions.get,
    onSelectionActionsUpdate: selectionActions.subscribe,
    editNewTitle: (title: string) => newTitle.set(title),
    select: (id: string, additive: boolean) => {
      if (!log.closed) log.append(selected, { id, additive });
    },
    toggle: (id: string) => {
      const todo = todos.get().find((t) => t.id === id);
      if (todo && !log.closed) log.append(updateTodo, { id, patch: { done: !todo.done } });
    },
  });
  cleanups.push(
    slots.register(panelsSlot, "todos:list", {
      kind: todosListKind,
      title: "Todos",
      placement: "main",
      order: 0,
      model,
    }),
  );

  return () => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    log.close();
  };
};
