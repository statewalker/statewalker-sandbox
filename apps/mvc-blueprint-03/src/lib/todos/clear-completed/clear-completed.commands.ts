import { Command } from "@statewalker/shared-commands";
import { z } from "zod";

/**
 * Asks the user whether to delete the completed todos. Answered by the
 * clear-completed domain; resolves as soon as the question is shown (or not
 * needed) — never waits for the answer.
 */
export const todosClearCompletedAsk = Command.required("todos:clear-completed:ask")
  .input(z.object({}))
  .output(z.object({ asked: z.boolean() }))
  .build();
