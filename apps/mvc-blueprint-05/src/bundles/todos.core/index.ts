/**
 * todos.core — owns the collection slice and performs the `todos/api` effect.
 * `todos:collection` is a derivation of this slice; only this update writes it.
 */
import {
  type Activator,
  defineMsg,
  disposers,
  getKey,
  getStore,
  hasKey,
  next,
  setKey,
  useFields,
} from "../../kernel/index.ts";
import {
  TODO_API_KEY,
  type Todo,
  type TodoApi,
  type TodoApiEffect,
  type TodoReply,
  todosCollection,
} from "../todos/api/index.ts";
import { createMemTodoApi } from "./mem-api.ts";

interface CoreState {
  readonly todos: readonly Todo[];
  readonly loaded: boolean;
}
const loaded = defineMsg<{ todos: readonly Todo[] }>("todos.core/loaded");
const LOAD = { type: "todos.core/load" } as const;

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  if (!hasKey(context, TODO_API_KEY)) setKey(context, TODO_API_KEY, createMemTodoApi());
  const { store } = useAppFields(context);
  const api = getKey<TodoApi>(context, TODO_API_KEY);

  const offLoad = store.addEffectHandler<typeof LOAD>(LOAD.type, async (_fx, io) => {
    const todos = await api.list();
    io.dispatch(loaded({ todos }));
  });
  const offApi = store.addEffectHandler<TodoApiEffect>("todos/api", async (fx, io) => {
    let error: string | undefined;
    try {
      const { call } = fx;
      if (call.op === "add") await api.add(call.title);
      else if (call.op === "update") await api.update(call.id, call.patch);
      else for (const id of call.ids) await api.remove(id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // Outcome after the collection: a reply handler sees the new todos already.
    if (!error) io.dispatch(loaded({ todos: await api.list() }));
    if (fx.reply) {
      const reply: TodoReply = { type: fx.reply, ref: fx.ref, ok: !error, error, call: fx.call };
      io.dispatch(reply);
    }
  });

  const slice = store.addSlice<CoreState>({
    id: "todos.core",
    init: () => next({ todos: [], loaded: false }, LOAD),
    update: (state, msg) => (loaded.match(msg) ? { todos: msg.todos, loaded: true } : state),
  });
  return disposers(
    offLoad,
    offApi,
    slice.contribute(todosCollection, "todos.core", (state) =>
      state.loaded
        ? [
            {
              todos: state.todos,
              counts: {
                open: state.todos.filter((t) => !t.done).length,
                done: state.todos.filter((t) => t.done).length,
              },
            },
          ]
        : [],
    ),
    slice.dispose,
  );
};
