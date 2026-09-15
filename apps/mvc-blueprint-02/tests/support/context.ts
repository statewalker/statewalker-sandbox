import { Commands } from "@statewalker/shared-commands";
import { setLogger } from "@statewalker/shared-logger";
import { Slots } from "@statewalker/shared-slots";
import { type AppContext, setCommands, setSlots } from "@sys";
import { MemTodoApi, setTodoApi, type Todo } from "@todo/core";
import { newRecordingLogger } from "./logging.js";

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Several real turns: enough for a controller's awaits on MemTodoApi to land. */
export async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await tick();
}

/** A context with a plain bus, a plain slots bus, an in-memory api and a recording logger. */
export function newTestContext(rows: Todo[] = []) {
  const ctx: AppContext = {};
  const commands = new Commands();
  const slots = new Slots();
  const api = new MemTodoApi(rows);
  const recorder = newRecordingLogger();
  setCommands(ctx, commands);
  setSlots(ctx, slots);
  setTodoApi(ctx, api);
  setLogger(ctx, recorder.logger);
  return { ctx, commands, slots, api, recorder };
}
