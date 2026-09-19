import type { ConfirmView, TitleFormView, TodoListView } from "@b/todos/api";
import { constant, type ModelBinding } from "@kit/jr";

/** The Todos view models as json-render state: what each spec reads, writes and invokes. */

export const todoList = (m: TodoListView): ModelBinding => ({
  values: {
    items: [m.getItems, m.onItemsUpdate],
    selection: [m.getSelection, m.onSelectionUpdate],
    newTitle: [m.getNewTitle, m.onNewTitleUpdate],
    outcome: [m.getOutcome, m.onOutcomeUpdate],
  },
  actions: { toggle: m.toggle },
  actionLists: {
    toolbar: [m.getToolbar, m.onToolbarUpdate],
    selectionActions: [m.getSelectionActions, m.onSelectionActionsUpdate],
  },
  writes: { "/newTitle": (v) => m.setNewTitle(String(v)) },
  intents: {
    select: ({ id }) => m.select([String(id)]),
    // P0's Ctrl-click arithmetic: one copy for every technology (was one per renderer).
    toggleSelect: ({ id }) => {
      const s = m.getSelection();
      m.select(s.includes(String(id)) ? s.filter((x) => x !== id) : [...s, String(id)]);
    },
  },
});

export const titleForm = (m: TitleFormView): ModelBinding => ({
  values: { draft: [m.getDraft, m.onDraftUpdate], status: [m.getStatus, m.onStatusUpdate] },
  actions: { save: m.save, cancel: m.cancel },
  writes: { "/draft/title": (v) => m.editField("title", String(v)) },
});

export const confirm = (m: ConfirmView): ModelBinding => ({
  values: { question: constant(m.getQuestion()) },
  actions: { confirm: m.confirm, cancel: m.cancel },
});
