import { newAdapter } from "@statewalker/shared-adapters";
import type { TodoApi } from "./types.js";

/**
 * The todo api on the app context. No factory: a controller that resolves it
 * before the composition root set it fails loudly ("Adapter not found").
 */
export const [getTodoApi, setTodoApi, removeTodoApi] = newAdapter<TodoApi, Record<string, unknown>>(
  "todos:api",
  undefined,
  () => undefined,
);
