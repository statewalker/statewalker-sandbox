import { Commands } from "@statewalker/shared-commands";
import { beforeEach, describe, expect, it } from "vitest";
import {
  registerTodoCommands,
  todosAdd,
  MemTodoApi,
} from "@todo/core";

describe("B2 · claimed contract", () => {
  let commands: Commands;
  let api: MemTodoApi;
  let off: () => Promise<void>;

  beforeEach(() => {
    commands = new Commands();
    api = new MemTodoApi();
    off = registerTodoCommands(commands, api);
  });

  it("sets claimed=true when a listener claims by returning a Promise", async () => {
    const cmd = commands.call(todosAdd, { title: "test" });

    await cmd.promise;
    expect((cmd as any).claimed).toEqual(true);
  });

  it("makes claimed visible to lower-priority listeners when a higher-priority listener claims the command", async () => {
    const claimedValues: boolean[] = [];

    // Higher-priority listener (priority 0) that claims the command
    commands.listen(todosAdd, () => Promise.resolve({ id: "host" }), { priority: 0 });

    // Lower-priority listener (default priority -1) that observes claimed state
    commands.listen(todosAdd, (cmd) => {
      claimedValues.push((cmd as any).claimed);
      // Return void to be observe-only
    });

    const { id } = await commands.call(todosAdd, { title: "test" }).promise;

    // The higher-priority listener claimed the command
    expect(id).toBe("host");
    // The lower-priority listener should have seen claimed=true when it ran
    // (after the higher-priority listener claimed it)
    expect(claimedValues).toEqual([true]);
  });
});
