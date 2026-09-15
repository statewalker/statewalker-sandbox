import { newRegistry } from "@statewalker/shared-registry";
import { type ActionModel, createAction } from "@sys/action";
import { newChannels, stableGroup } from "@sys/model-kit";
import { batch, signal } from "@sys/signals";
import type {
  EditControl,
  EditModel,
  EditView,
  FormStatus,
  Todo,
  TodoDetailsView,
  TodoDraft,
  TodoFormView,
} from "./edit.model.js";

const frozenTodo = (todo: Todo): Todo =>
  Object.freeze({ id: todo.id, title: todo.title, done: todo.done });

export function createEditModel(todo: Todo): EditModel {
  const [register, cleanup] = newRegistry();
  let disposed = false;
  const channels = newChannels(() => disposed);
  register(() => channels.dispose());

  const alive = signal(true);
  const saved = signal<Todo>(frozenTodo(todo));
  const title = signal(todo.title);
  const done = signal(todo.done);
  const error = signal<string | undefined>(undefined);

  const draft = stableGroup((): TodoDraft => {
    const t = title();
    const d = done();
    return Object.freeze({ title: t, done: d });
  });

  // Reads every input before branching on the error.
  const status = stableGroup((): FormStatus => {
    const base = saved();
    const current = draft();
    const message = error();
    const dirty = current.title !== base.title || current.done !== base.done;
    const valid = current.title.trim() !== "";
    return Object.freeze(
      message === undefined ? { dirty, valid } : { dirty, valid, error: message },
    );
  });

  const own = (model: ActionModel): ActionModel => {
    register(() => model.dispose());
    return model;
  };
  const save = own(
    createAction({
      label: "Save",
      icon: "save",
      when: () => {
        const live = alive();
        const s = status();
        return live && s.dirty && s.valid;
      },
    }),
  );
  const cancel = own(createAction({ label: "Cancel", icon: "x", when: () => alive() }));

  const details: TodoDetailsView = Object.freeze({
    getTodo: () => saved(),
    onTodoUpdate: channels.channel(saved),
  });
  const form: TodoFormView = Object.freeze({
    getDraft: () => draft(),
    onDraftUpdate: channels.channel(draft),
    getStatus: () => status(),
    onStatusUpdate: channels.channel(status),
    setTitle: (value: string) => {
      if (!disposed) title(value);
    },
    setDone: (value: boolean) => {
      if (!disposed) done(value);
    },
    actions: Object.freeze({ save: save.view, cancel: cancel.view }),
  });
  const view: EditView = Object.freeze({ details, form });

  const control: EditControl = Object.freeze({
    reportError: (message: string | undefined) => {
      if (!disposed) error(message);
    },
    markSaved: (next: Todo) => {
      if (disposed) return;
      batch(() => {
        saved(frozenTodo(next));
        title(next.title);
        done(next.done);
        error(undefined);
      });
    },
    actions: Object.freeze({ save: save.control, cancel: cancel.control }),
  });

  return Object.freeze({
    view,
    control,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      alive(false);
      void cleanup();
    },
  });
}
