import {
  answer,
  type Context,
  getConfig,
  getLogger,
  getSlots,
  isProvided,
  type Scope,
  useFields,
} from "@p5/kernel";
import {
  todoApiAdapter,
  todosAdd,
  todosCollectionSlot,
  todosRemove,
  todosUpdate,
} from "@p5/todos/api";
import { createCollectionModel } from "./collection.model.js";
import { MemTodoApi, seedTodos } from "./mem-todo-api.js";

export { MemTodoApi, seedTodos };

const fields = useFields({ slots: getSlots, log: getLogger, api: todoApiAdapter.get });

/**
 * `todos.core`: provides `todos:api` (unless the host did), OWNS the todos collection — publishes
 * it to `todos:collection` and is its only writer — and answers the write commands. Every await
 * goes through the bundle scope: after deactivation no continuation writes, and a caller whose
 * call was claimed here gets `abandoned` (its handler is withdrawn with the scope).
 */
export default async function todosCore(context: Context, scope: Scope) {
  if (!isProvided(context, todoApiAdapter.key)) {
    const delay = Number(getConfig(context)["todos:delay-ms"] ?? 0);
    todoApiAdapter.set(context, new MemTodoApi(seedTodos, delay));
  }
  const { slots, log, api } = fields(context);
  const collection = createCollectionModel();
  scope.defer(() => collection.dispose());
  const { publishTodos } = collection.control;
  const current = () => collection.view.getTodos();
  const loaded = scope
    .task(api.list())
    .then(publishTodos, (error) => log.warn("todos:load failed", { error: String(error) }));

  scope.defer(
    answer(slots, todosAdd, "todos.core", async ({ payload }) => {
      await scope.task(loaded);
      const todo = await scope.task(api.add(payload.title));
      publishTodos([...current(), todo]);
      return todo;
    }),
  );
  scope.defer(
    answer(slots, todosUpdate, "todos.core", async ({ payload }) => {
      await scope.task(loaded);
      const todo = await scope.task(api.update(payload.id, payload.patch));
      publishTodos(current().map((t) => (t.id === todo.id ? todo : t)));
      return todo;
    }),
  );
  scope.defer(
    answer(slots, todosRemove, "todos.core", async ({ payload }) => {
      await scope.task(loaded);
      const gone = new Set<string>();
      try {
        for (const id of payload.ids) if (await scope.task(api.remove(id))) gone.add(id);
      } finally {
        // What landed is published even when a later removal failed.
        if (gone.size > 0) publishTodos(current().filter((t) => !gone.has(t.id)));
      }
      return gone.size;
    }),
  );
  scope.defer(slots.provide(todosCollectionSlot, collection.view));
}
