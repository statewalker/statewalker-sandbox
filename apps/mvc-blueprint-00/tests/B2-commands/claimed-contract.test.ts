import { Commands } from "@statewalker/shared-commands";
import { MemTodoApi, registerTodoCommands, todosAdd } from "@todo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("B2 · claimed contract", () => {
  let commands: Commands;
  let api: MemTodoApi;
  let off: () => Promise<void>;

  beforeEach(() => {
    commands = new Commands();
    api = new MemTodoApi();
    off = registerTodoCommands(commands, api);
  });

  afterEach(async () => {
    await off();
  });

  it("runs the core default when no host claims the command", async () => {
    const { id } = await commands.call(todosAdd, { title: "test" }).promise;

    expect(typeof id).toBe("string");
    expect(id).not.toBe("host");
  });

  it("does not run lower-priority listeners once a higher-priority listener claims the command", async () => {
    const lowerCalls: unknown[] = [];

    // Higher-priority listener (priority 0) that claims the command,
    // like a host handler overriding the core default (priority -1).
    commands.listen(todosAdd, () => Promise.resolve({ id: "host" }), { priority: 0 });

    // A listener below the core default: with shared-commands 0.3 a claim
    // stops the dispatch, so neither it nor the default runs.
    commands.listen(
      todosAdd,
      (cmd) => {
        lowerCalls.push(cmd.payload);
      },
      { priority: -2 },
    );

    const { id } = await commands.call(todosAdd, { title: "test" }).promise;

    expect(id).toBe("host");
    expect(lowerCalls).toEqual([]);
  });
});
