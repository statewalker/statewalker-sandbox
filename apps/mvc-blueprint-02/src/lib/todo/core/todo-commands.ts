import type { Command, CommandListener, Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import {
  TODO_COMMANDS,
  todosAdd,
  todosClearCompleted,
  todosRemove,
  todosResolveActions,
  todosToggle,
} from "./declarations.js";

import type { TodoApi } from "./types.js";

/**
 * A claim stops the dispatch (shared-commands 0.3, statewalker/statewalker-shared#60):
 * once a higher-priority listener (a host) claims the command, lower-priority
 * listeners do not run. A fallback at a negative priority therefore fires only
 * when nobody claimed first, and needs no guard of its own.
 */
const fallback =
  <P, R>(handler: (cmd: Command<P, R>) => Promise<R>): CommandListener<P, R> =>
  (cmd) =>
    handler(cmd);

/**
 * Returns the registry's cleanup: LIFO, idempotent, and it does not strand the
 * remaining listeners when one throws. Async, so callers await it.
 */
export function registerTodoCommands(commands: Commands, api: TodoApi): () => Promise<void> {
  const at = { priority: -1 };
  const [register, cleanup] = newRegistry();
  // Each `listen()` returns its own off; the registry owns them from here.
  for (const off of [
    // Each default is a thin delegation to the external service. The command
    // layer decides WHETHER an operation happens and who may override it; the
    // api decides HOW. Keeping the handler this thin is what lets a host swap
    // the api without touching a command, and vice versa.
    commands.listen(
      todosAdd,
      fallback<{ title: string }, { id: string }>(async (cmd) => {
        const todo = await api.add(cmd.payload.title);
        return { id: todo.id };
      }),
      at,
    ),
    commands.listen(
      todosToggle,
      fallback<{ id: string }, { done: boolean }>(async (cmd) => {
        const todo = await api.toggle(cmd.payload.id);
        return { done: todo?.done ?? false };
      }),
      at,
    ),
    commands.listen(
      todosRemove,
      fallback<{ id: string }, { removed: boolean }>(async (cmd) => ({
        removed: await api.remove(cmd.payload.id),
      })),
      at,
    ),
    commands.listen(
      todosClearCompleted,
      fallback<Record<string, never>, { cleared: number }>(async () => ({
        cleared: await api.clearCompleted(),
      })),
      at,
    ),
    commands.listen(
      todosResolveActions,
      fallback<{ ids: string[] }, { keys: string[] }>(async () => ({
        keys: TODO_COMMANDS.map((c) => c.key),
      })),
      at,
    ),
  ]) {
    register(off);
  }
  return cleanup;
}
