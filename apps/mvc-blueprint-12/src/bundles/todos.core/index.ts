import {
  todoApiAdapter,
  todosAdd,
  todosCollectionSlot,
  todosRemove,
  todosUpdate,
} from "@b/todos/api";
import {
  type Controller,
  getCommands,
  getConfig,
  getLogger,
  getSlots,
  isProvided,
  untracked,
  newRegistry,
  useFields,
} from "@kernel";
import { createCollectionModel } from "./collection.model.js";
import { MemTodoApi, seedTodos } from "./mem-todo-api.js";

export { MemTodoApi, seedTodos };

const fields = useFields({
  slots: getSlots,
  commands: getCommands,
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
  const { slots, commands, log: rootLog, api } = fields(context);
  const log = rootLog.child({ bundle: "todos.core" });
  const [register, cleanup] = newRegistry();
  let active = true;

  const collection = createCollectionModel();
  register(() => collection.dispose());
  const current = () => untracked(collection.view.todos);
  const loaded = api.list().then(
    (todos) => {
      if (active) collection.control.publishTodos(todos);
    },
    (error) => log.warn("todos:load failed", { error: String(error) }),
  );

  register(
    commands.listen(todosAdd, async ({ payload }) => {
      await loaded;
      const todo = await api.add(payload.title);
      if (active) collection.control.publishTodos([...current(), todo]);
      return todo;
    }),
  );
  register(
    commands.listen(todosUpdate, async ({ payload }) => {
      await loaded;
      const todo = await api.update(payload.id, payload.patch);
      if (active)
        collection.control.publishTodos(current().map((t) => (t.id === todo.id ? todo : t)));
      return todo;
    }),
  );
  register(
    commands.listen(todosRemove, async ({ payload }) => {
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
