import { Command } from "@statewalker/shared-commands";
import { z } from "zod";

/** Opens the editor on one todo. Answered by the edit domain; resolves once the editor is shown. */
export const todosEditOpen = Command.required("todos:edit:open")
  .input(z.object({ id: z.string() }))
  .output(z.object({ opened: z.boolean() }))
  .build();
