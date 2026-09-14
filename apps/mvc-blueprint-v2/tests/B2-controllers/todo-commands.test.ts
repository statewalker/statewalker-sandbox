import { CommandError, Commands } from "@statewalker/shared-commands";
import {
  MemTodoApi,
  registerTodoCommands,
  TODO_COMMANDS,
  todosAdd,
  todosClearCompleted,
  todosResolveActions,
  todosToggle,
} from "@todo/core";
import { beforeEach, describe, expect, it } from "vitest";

describe("B2 · todo commands · command surface", () => {
  let commands: Commands;
  let api: MemTodoApi;
  let off: () => Promise<void>;

  beforeEach(() => {
    commands = new Commands();
    api = new MemTodoApi();
    off = registerTodoCommands(commands, api);
  });

  it("adds a todo through the core default", async () => {
    const { id } = await commands.call(todosAdd, { title: "write" }).promise;
    expect(await api.list()).toEqual([{ id, title: "write", done: false }]);
  });

  it("lets a host override at priority 0 — the core default does NOT also run", async () => {
    commands.listen(todosAdd, () => Promise.resolve({ id: "host" }), { priority: 0 });
    const { id } = await commands.call(todosAdd, { title: "write" }).promise;
    expect(id).toBe("host");
    expect(await api.list()).toEqual([]); // the negative-priority default declined
  });

  it("still runs the default when nothing overrides", async () => {
    const { done } = await commands.call(todosToggle, { id: "missing" }).promise;
    // Witnessed on the api, not inferred from the store: toggling a missing id is
    // a no-op there, so the store looks identical whether the default ran or not.
    expect(api.calls).toContain("toggle");
    expect(done).toBe(false);
  });

  it("reports an unregistered command as no-handlers, not a hanging promise", async () => {
    await off();
    const err = await commands.call(todosAdd, { title: "x" }).promise.then(
      () => undefined,
      (e: CommandError) => e,
    );
    expect(err).toBeInstanceOf(CommandError);
    expect(err?.kind).toBe("no-handlers");
  });

  it("offers the whole namespace when nothing claims resolve-actions", async () => {
    const { keys } = await commands.call(todosResolveActions, { ids: ["1"] }).promise;
    expect(keys).toEqual(TODO_COMMANDS.map((c) => c.key));
  });

  it("lets a host narrow the offered actions", async () => {
    commands.listen(todosResolveActions, () => Promise.resolve({ keys: ["todos:toggle"] }), {
      priority: 0,
    });
    const { keys } = await commands.call(todosResolveActions, { ids: ["1"] }).promise;
    expect(keys).toEqual(["todos:toggle"]);
  });

  it("clears only completed todos", async () => {
    api = new MemTodoApi([
      { id: "1", title: "a", done: true },
      { id: "2", title: "b", done: false },
    ]);
    commands = new Commands();
    off = registerTodoCommands(commands, api);
    const { cleared } = await commands.call(todosClearCompleted, {}).promise;
    expect(cleared).toBe(1);
    expect((await api.list()).map((t) => t.id)).toEqual(["2"]);
  });

  it("carries a label on every declaration, so a menu need not be hand-written", () => {
    for (const decl of TODO_COMMANDS) {
      expect(decl.label, `${decl.key} needs a label`).toBeTruthy();
    }
  });
});
