import { Command, type Commands } from "@statewalker/shared-commands";
import type { Logger } from "@statewalker/shared-logger";
import { describeError } from "@sys/attempt";
import { z } from "zod";
import type { NotificationMessage } from "./notifications.model.js";

/** Shows a message to the user. Required: with no notifications domain activated, the call rejects. */
export const notify = Command.required("notifications:notify")
  .input(z.object({ text: z.string().min(1), level: z.enum(["info", "error"]) }))
  .output(z.object({ shown: z.boolean() }))
  .build();

/** Fire-and-forget `notify` for controllers: a failure to show becomes a warning, never an error in the caller. */
export function notifyUser(commands: Commands, log: Logger, message: NotificationMessage): void {
  commands
    .call(notify, { text: message.text, level: message.level })
    .promise.catch((error: unknown) =>
      log.warn(`notify failed: ${describeError(error)}`, { text: message.text }),
    );
}
