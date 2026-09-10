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

    // Higher-priority listener (priority 0) that claims the command.
    // Like a host handler overriding the core default.
    commands.listen(todosAdd, () => Promise.resolve({ id: "host" }), { priority: 0 });

    // Lower-priority listener (priority -1) that observes claimed state.
    // Like the core default handlers checking if a host has already claimed the command.
    commands.listen(todosAdd, (cmd) => {
      claimedValues.push((cmd as any).claimed);
      // Return void to be observe-only
    }, { priority: -1 });

    const { id } = await commands.call(todosAdd, { title: "test" }).promise;

    // The higher-priority listener claimed the command
    expect(id).toBe("host");
    // The lower-priority listener ran and saw claimed=true
    expect(claimedValues).toEqual([true]);
  });
});
