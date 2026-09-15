import { Commands } from "@statewalker/shared-commands";
import { setLogger } from "@statewalker/shared-logger";
import { Slots } from "@statewalker/shared-slots";
import { type AppContext, setCommands, setSlots } from "@sys/context";
import { setTodoApi, type Todo } from "@todos/core";
import { ScriptedTodoApi } from "./api.js";
import { newRecordingLogger } from "./logging.js";

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Several real turns: enough for controllers' awaits on the in-memory api and async registry releases to land. */
export async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await tick();
}

/** A context with a commands bus, a slots bus, a scripted in-memory api and a recording logger. */
export function newTestContext(rows: readonly Todo[] = []) {
  const ctx: AppContext = {};
  const commands = new Commands();
  const slots = new Slots();
  const api = new ScriptedTodoApi(rows);
  const recorder = newRecordingLogger();
  setCommands(ctx, commands);
  setSlots(ctx, slots);
  setTodoApi(ctx, api);
  setLogger(ctx, recorder.logger);
  return { ctx, commands, slots, api, recorder };
}
