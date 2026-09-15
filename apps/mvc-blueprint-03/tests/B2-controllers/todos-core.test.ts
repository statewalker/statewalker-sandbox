import { Commands } from "@statewalker/shared-commands";
import type { AppContext } from "@sys/context";
import { getTodoApi, MemTodoApi, setTodoApi } from "@todos/core";
import { todosChanged } from "@todos/events";
import { describe, expect, it } from "vitest";
import { ScriptedTodoApi } from "../support/api.js";
import { tick } from "../support/context.js";

describe("B2 · todos core", () => {
  it("lists, adds, updates and removes, always async and never sharing arrays", async () => {
    const api = new MemTodoApi([{ id: "t1", title: "milk", done: false }]);
    const listed = await api.list();
    listed.push({ id: "x", title: "intruder", done: false });
    expect((await api.list()).map((t) => t.id)).toEqual(["t1"]);
    const added = await api.add("bread");
    expect(added).toEqual({ id: "t2", title: "bread", done: false });
    expect(await api.update("t1", { done: true })).toEqual({ id: "t1", title: "milk", done: true });
    expect(await api.update("t1", { title: "oat milk" })).toEqual({
      id: "t1",
      title: "oat milk",
      done: true,
    });
    expect(await api.remove("t2")).toBe(true);
    expect(await api.remove("t2")).toBe(false);
    expect((await api.list()).map((t) => t.title)).toEqual(["oat milk"]);
    expect(api.calls).toEqual([
      "list",
      "list",
      "add",
      "update",
      "update",
      "remove",
      "remove",
      "list",
    ]);
  });

  it("update of an unknown id rejects", async () => {
    await expect(new MemTodoApi().update("t9", { done: true })).rejects.toThrow(
      "todo not found: t9",
    );
  });

  it("the api adapter throws until the composition root sets it", () => {
    const ctx: AppContext = {};
    expect(() => getTodoApi(ctx)).toThrow(/Adapter not found: todos:api/);
    const api = new MemTodoApi();
    setTodoApi(ctx, api);
    expect(getTodoApi(ctx)).toBe(api);
  });

  it("todos:changed is a silent broadcast: every listener observes, nobody claims, nothing rejects", async () => {
    const commands = new Commands();
    const seen: string[] = [];
    commands.listen(todosChanged, (cmd) => {
      seen.push(`a:${cmd.payload.source}`);
    });
    commands.listen(todosChanged, (cmd) => {
      seen.push(`b:${cmd.payload.source}`);
    });
    const cmd = commands.call(todosChanged, { source: "todos.edit" });
    let rejected = false;
    cmd.promise.catch(() => {
      rejected = true;
    });
    const lonely = new Commands().call(todosChanged, { source: "nobody listens" });
    lonely.promise.catch(() => {
      rejected = true;
    });
    await tick();
    expect(seen).toEqual(["a:todos.edit", "b:todos.edit"]);
    expect(rejected).toBe(false);
  });

  it("the scripted api fails on demand and heals", async () => {
    const api = new ScriptedTodoApi([{ id: "t1", title: "milk", done: false }]);
    api.fail("update", "disk full");
    await expect(api.update("t1", { done: true })).rejects.toThrow("disk full");
    api.heal("update");
    await expect(api.update("t1", { done: true })).resolves.toMatchObject({ done: true });
  });
});
