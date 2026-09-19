import { agentActionsSlot } from "@b/agent/api";
import { todosCompose } from "@b/todos/api";
import { type Controller, getCommands, getSlots, newRegistry, useFields } from "@kernel";
import { z } from "zod";

const fields = useFields({ slots: getSlots, commands: getCommands });

/**
 * `agent.todos-actions` (feature `agent.todos`): lets a generated UI compose a todo — the
 * allow-list entry for the existing `todos:compose` command. Edits no Todos file.
 */
export const activate: Controller = async (context) => {
  const { slots, commands } = fields(context);
  const [register, cleanup] = newRegistry();
  register(
    slots.register(agentActionsSlot, "todos.compose", {
      description:
        "Open the todo editor in create mode with the title prefilled; the user reviews and saves it.",
      params: z.object({ title: z.string().trim().min(1).describe("the todo title") }),
      run: (params: { title: string }) => commands.call(todosCompose, params).promise,
    } as never),
  );
  return cleanup;
};
