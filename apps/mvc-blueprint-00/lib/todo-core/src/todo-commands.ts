import { newRegistry } from "@statewalker/shared-registry";
import type { Command, CommandListener, Commands } from "@statewalker/shared-commands";
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
 * What a fallback listener actually receives. `claimed` is set by the bus on the
 * dispatched command but declared only on its internal type, so it is spelled
 * out rather than silently relied upon (spec §4.7). Exported so the B2 guard
 * reads it through this same type: if the upstream field moves, the guard and
 * the fallback fail to compile together, rather than one hiding behind `any`.
 */
export type Claimable<P, R> = Command<P, R> & { readonly claimed: boolean };

/**
 * Negative priority ORDERS listeners; it does not STOP them. A fallback must
 * therefore decline explicitly when a host has already claimed the command —
 * returning nothing is observe-only, which leaves the host's claim untouched.
 */
const fallback =
  <P, R>(handler: (cmd: Claimable<P, R>) => Promise<R>): CommandListener<P, R> =>
  (cmd) => {
    const c = cmd as Claimable<P, R>;
    return c.claimed ? undefined : handler(c);
  };

/**
 * Returns the registry's cleanup: LIFO, idempotent, and it does not strand the
 * remaining listeners when one throws (spec §4.9). Async, so callers await it.
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
