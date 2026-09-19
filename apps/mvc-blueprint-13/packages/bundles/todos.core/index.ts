import {
  todoApiAdapter,
  todosAdd,
  todosCollectionSlot,
  todosRemove,
  todosUpdate,
} from "@p5/todos/api";
import {
  answer,
  type Controller,
  getConfig,
  getLogger,
  getSlots,
  isProvided,
  newRegistry,
  useFields,
} from "@p5/kernel";
import { createCollectionModel } from "./collection.model.js";
import { MemTodoApi, seedTodos } from "./mem-todo-api.js";

export { MemTodoApi, seedTodos };

const fields = useFields({
  slots: getSlots,
  log: getLogger,
  config: getConfig,
  api: todoApiAdapter.get,
});

/**
 * `todos.core`: provides `todos:api` (unless the host did), OWNS the todos collection — publishes
 * it to `todos:collection` and is its only writer — and answers the write commands.
 */
export const activate: Controller = async (context) => {
  if (!isProvided(context, todoApiAdapter.key)) {
    const delay = Number(getConfig(context)["todos:delay-ms"] ?? 0);
    todoApiAdapter.set(context, new MemTodoApi(seedTodos, delay));
  }
  const { slots, log: rootLog, api } = fields(context);
  const log = rootLog.child({ bundle: "todos.core" });
  const [register, cleanup] = newRegistry();
  let active = true;

  const collection = createCollectionModel();
  register(() => collection.dispose());
  const current = () => collection.view.getTodos();
  const loaded = api.list().then(
    (todos) => {
      if (active) collection.control.publishTodos(todos);
    },
    (error) => log.warn("todos:load failed", { error: String(error) }),
  );

  register(
    answer(slots, todosAdd, async ({ payload }) => {
      await loaded;
      const todo = await api.add(payload.title);
      if (active) collection.control.publishTodos([...current(), todo]);
      return todo;
    }),
  );
  register(
    answer(slots, todosUpdate, async ({ payload }) => {
      await loaded;
      const todo = await api.update(payload.id, payload.patch);
      if (active)
        collection.control.publishTodos(current().map((t) => (t.id === todo.id ? todo : t)));
      return todo;
    }),
  );
  register(
    answer(slots, todosRemove, async ({ payload }) => {
      await loaded;
      const gone = new Set<string>();
      try {
        for (const id of payload.ids) if (await api.remove(id)) gone.add(id);
      } finally {
        // What landed is published even when a later removal failed.
        if (active && gone.size > 0) {
          collection.control.publishTodos(current().filter((t) => !gone.has(t.id)));
        }
      }
      return gone.size;
    }),
  );
  register(slots.provide(todosCollectionSlot, collection.view));

  return async () => {
    active = false;
    await cleanup();
  };
};
