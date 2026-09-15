import { Command } from "@statewalker/shared-commands";
import { z } from "zod";

/**
 * "The todos changed" — a broadcast between the todos domains. Silent: every
 * listener observes and returns nothing, nobody claims, and the caller never
 * awaits it. `source` names the domain that changed them.
 */
export const todosChanged = Command.silent("todos:changed")
  .input(z.object({ source: z.string() }))
  .output(z.void())
  .build();
