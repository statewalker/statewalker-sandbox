import { Command } from "@statewalker/shared-commands";
import { z } from "zod";

/**
 * Every operation is a command, and every command is overridable. The core
 * registers its own handlers at NEGATIVE priority — the package's documented
 * fallback convention — so a host can route add through an approval step, or
 * delete through a trash list, by listening at 0.
 *
 * `label`, `icon` and `description` are catalog metadata for whatever lists
 * these commands. Nothing in this app reads them: a view may not read the
 * registry, and the todo list spells its own button labels. Icon names are
 * lucide's.
 */
export const todosAdd = Command.required("todos:add")
  .input(z.object({ title: z.string().min(1) }))
  .output(z.object({ id: z.string() }))
  .label("Add")
  .icon("plus")
  .description("Add a new todo")
  .build();

export const todosToggle = Command.required("todos:toggle")
  .input(z.object({ id: z.string() }))
  .output(z.object({ done: z.boolean() }))
  .label("Toggle")
  .icon("check")
  .description("Mark a todo done or not done")
  .build();

export const todosRemove = Command.required("todos:remove")
  .input(z.object({ id: z.string() }))
  .output(z.object({ removed: z.boolean() }))
  .label("Delete")
  .icon("trash-2")
  .description("Delete a todo")
  .build();

export const todosClearCompleted = Command.required("todos:clear-completed")
  .input(z.object({}))
  .output(z.object({ cleared: z.number() }))
  .label("Clear completed")
  .icon("eraser")
  .description("Remove every completed todo")
  .build();

/**
 * Which todo commands apply to a selection — an overridable query kept from the
 * seed. The core default offers the whole namespace; a host listening at
 * priority 0 narrows it (both pinned in `B2 · todo commands`). Nothing in this
 * app asks it: there is no menu to fill.
 */
export const todosResolveActions = Command.required("todos:resolve-actions")
  .input(z.object({ ids: z.array(z.string()) }))
  .output(z.object({ keys: z.array(z.string()) }))
  .label("Resolve actions")
  .description("Which commands apply to this selection")
  .build();

/**
 * An RPC between controllers: the todo controller answers it, the stats
 * controller asks it once to seed its baseline. Required, so an asker with no
 * todo controller present gets `no-handlers` — loudly — rather than a hang.
 */
export const todosSummary = Command.required("todos:summary")
  .input(z.object({}))
  .output(z.object({ total: z.number(), done: z.number() }))
  .label("Summary")
  .description("How many todos exist, and how many are done")
  .build();

export const TODO_COMMANDS = [todosAdd, todosToggle, todosRemove, todosClearCompleted];
