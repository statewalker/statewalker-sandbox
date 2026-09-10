import { Command } from "@statewalker/shared-commands";
import { z } from "zod";

/**
 * Every operation is a command, and every command is overridable. The core
 * registers its own handlers at NEGATIVE priority — the package's documented
 * fallback convention — so a host can route add through an approval step, or
 * delete through a trash list, by listening at 0.
 *
 * `label` and `icon` are not decoration: the controller copies them into the
 * menu model (spec §4.4), because the view may not read the registry. Icon names
 * are lucide's, which the shadcn layer (B5) renders.
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
 * A registry is a flat catalog with no notion of applicability (drive file 06
 * §3), so a right-click without this renders every declaration in it — the
 * `ui:*` vocabulary included. When nothing claims it, the whole namespace is
 * offered, which is the documented fallback.
 */
export const todosResolveActions = Command.required("todos:resolve-actions")
  .input(z.object({ ids: z.array(z.string()) }))
  .output(z.object({ keys: z.array(z.string()) }))
  .label("Resolve actions")
  .description("Which commands apply to this selection")
  .build();

export const TODO_COMMANDS = [todosAdd, todosToggle, todosRemove, todosClearCompleted];
