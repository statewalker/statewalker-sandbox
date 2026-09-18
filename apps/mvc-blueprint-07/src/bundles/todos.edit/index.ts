import { type Controller, useFields } from "../../kernel/context.js";
import { defineIntent, isIntent, isOutcome, openLog } from "../../kernel/log.js";
import { getSlots } from "../../kernel/slots.js";
import { type IntentAction, intentAction } from "../../kit/action.js";
import { type Cell, cell, derived } from "../../kit/cell.js";
import { followSlot } from "../../kit/follow.js";
import { panelsSlot } from "../shell/api/index.js";
import {
  addTodo,
  collectionSlot,
  compose,
  getTitleValidator,
  hasTitleValidator,
  openEditor,
  removeTodos,
  selectionActionsSlot,
  selectionSlot,
  type TitleValidator,
  type Todo,
  type TodoDraft,
  type TodoEditorStatus,
  type TodoEditorView,
  todoEditorKind,
  updateTodo,
} from "../todos/api/index.js";

/** Private intents: the editor's two gestures. The save record carries the committed draft. */
const save = defineIntent<{ session: string; title: string }>("todos.edit:save");
const cancel = defineIntent<{ session: string }>("todos.edit:cancel");

const requireTitle: TitleValidator = async (title) =>
  title.trim() === "" ? "Title is required" : undefined;

interface Session {
  readonly id: string;
  readonly mode: "create" | "edit";
  readonly todoId?: string;
  readonly draft: Cell<TodoDraft>;
  readonly status: Cell<TodoEditorStatus>;
  readonly actions: IntentAction[];
  close(): void;
}

const fields = useFields({ slots: getSlots });

export const activate: Controller = async (context) => {
  const { slots } = fields(context);
  const validate = hasTitleValidator(context) ? getTitleValidator(context) : requireTitle;
  const log = openLog(context, "todos.edit");
  const todos = followSlot(
    slots,
    collectionSlot,
    (c) => ({ get: c.getTodos, subscribe: c.onTodosUpdate }),
    [] as readonly Todo[],
  );
  const sessions = new Map<string, Session>();
  /** which session each save record belongs to — so an outcome can find its form */
  const saves = new Map<number, string>();

  // The form's error is a projection: the latest outcome of this session's save intents.
  const offErrors = log.project((record) => {
    if (isIntent(record, save)) saves.set(record.seq, record.payload.session);
    if (!isOutcome(record, save)) return;
    const session = sessions.get(saves.get(record.cause) ?? "");
    saves.delete(record.cause);
    session?.status.patch({ error: record.ok ? undefined : record.error });
  });

  const openSession = (mode: "create" | "edit", title: string, todoId?: string) => {
    const id = mode === "create" ? "todos:editor:new" : `todos:editor:${todoId}`;
    const existing = sessions.get(id);
    if (existing) {
      if (mode === "create") existing.draft.set({ title }); // a new compose resets the whole draft
      return;
    }
    const draft = cell<TodoDraft>({ title });
    const status = cell<TodoEditorStatus>({ mode });
    const saveAction = intentAction(log, {
      label: mode === "create" ? "Add" : "Save",
      commit: () => log.append(save, { session: id, title: draft.get().title }),
    });
    const cancelAction = intentAction(log, {
      label: "Cancel",
      commit: () => log.append(cancel, { session: id }),
    });
    const model: TodoEditorView = Object.freeze({
      getDraft: draft.get,
      onDraftUpdate: draft.subscribe,
      getStatus: status.get,
      onStatusUpdate: status.subscribe,
      editTitle: (value: string) => draft.patch({ title: value }),
      save: saveAction.view,
      cancel: cancelAction.view,
    });
    const withdraw = slots.register(panelsSlot, id, {
      kind: todoEditorKind,
      title: mode === "create" ? "New todo" : `Edit “${title}”`,
      placement: "side",
      model,
    });
    const session: Session = {
      id,
      mode,
      todoId,
      draft,
      status,
      actions: [saveAction, cancelAction],
      close() {
        if (sessions.get(id) !== session) return;
        sessions.delete(id);
        withdraw();
        for (const action of session.actions) action.dispose();
        draft.dispose();
        status.dispose();
      },
    };
    sessions.set(id, session);
  };

  log.handle(openEditor, ({ payload }) => {
    const todo = todos.get().find((t) => t.id === payload.id);
    if (!todo) throw new Error(`no todo ${payload.id}`);
    openSession("edit", todo.title, todo.id);
  });
  log.handle(compose, ({ payload }) => openSession("create", payload.title));
  log.handle(cancel, ({ payload }) => sessions.get(payload.session)?.close());

  // A multi-step commit: validate (async), then mutate. The committed title is the record's payload,
  // captured at submit — nothing below re-reads the draft.
  log.handle(save, async (record) => {
    const { session: id, title: raw } = record.payload;
    const title = raw.trim();
    const problem = await validate(title);
    if (problem) throw new Error(problem);
    const session = sessions.get(id);
    if (!session) throw new Error("The editor was closed before the save reached the store");
    // Optimistic concurrency over the log: did anything remove this todo while we validated?
    const removed = log
      .since(record.seq)
      .some((r) => isOutcome(r, removeTodos) && r.ok && r.value?.includes(session.todoId ?? ""));
    if (removed) throw new Error("This todo was deleted while saving");
    if (session.mode === "edit" && session.todoId) {
      await log.request(
        updateTodo,
        { id: session.todoId, patch: { title } },
        { cause: record.seq },
      );
    } else {
      await log.request(addTodo, { title }, { cause: record.seq });
    }
    session.close();
  });

  // "Edit" in the list's selection actions: enabled with exactly one todo selected.
  const selection = followSlot(
    slots,
    selectionSlot,
    (s) => ({ get: s.getSelected, subscribe: s.onSelectedUpdate }),
    [] as readonly string[],
  );
  const one = derived([selection], () => selection.get().length === 1);
  const edit = intentAction(log, {
    label: "Edit",
    guard: one,
    commit: () => log.append(openEditor, { id: selection.get()[0] }),
  });
  const unEdit = slots.provide(selectionActionsSlot, { id: "edit", order: 20, action: edit.view });

  return () => {
    unEdit();
    edit.dispose();
    one.dispose();
    selection.dispose();
    for (const session of [...sessions.values()]) session.close();
    offErrors();
    log.close();
    todos.dispose();
  };
};
