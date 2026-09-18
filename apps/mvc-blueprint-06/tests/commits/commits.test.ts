/** §10 commit semantics when every commit is a message. */
import { afterEach, describe, expect, it } from "vitest";
import { workbenchHeadless } from "../../src/apps/index.js";
import type { ClearCompletedState, EditorState } from "../../src/bundles/todos/api/index.js";
import { contactId, list, titles, todoId } from "../scenario/scenario.js";
import { gatedTodoApi } from "../support/gated-api.js";
import { findAction, type Harness, start, tick, waitFor } from "../support/headless.js";

const seed = () =>
  gatedTodoApi([
    { id: "t1", title: "Buy milk", done: false },
    { id: "t2", title: "Write report", done: false },
    { id: "t3", title: "Call plumber", done: true },
  ]);

describe("commit time", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    if (!h) return;
    expect(h.errors()).toEqual([]);
    await h.stop();
    h = undefined;
  });

  it("edit, Save, keep typing while it runs: the service gets the value at Save; the rest is the next commit", async () => {
    const api = seed();
    h = await start(workbenchHeadless({ todoApi: api, notifyTimeoutMs: 60_000 }));
    await waitFor(() => titles(h as Harness).length === 3);
    h.send("todos:list", { type: "select", id: "t1", additive: false });
    h.dispatch(findAction(list(h)?.selectionActions, "Edit"));
    h.send("todos:editor", { type: "edit", title: "Buy oat milk" });
    api.gate.hold = true;
    h.dispatch(h.view<EditorState>("todos:editor")?.save);
    h.send("todos:editor", { type: "edit", title: "Buy oat milk and bread" });
    expect(api.gate.calls.at(-1)).toEqual({
      method: "update",
      args: ["t1", { title: "Buy oat milk" }],
    });
    // While running: visibly refused, and a second Save does not reach the service.
    const running = h.view<EditorState>("todos:editor");
    expect(running?.save).toMatchObject({ enabled: false, running: true });
    h.send("todos:editor", { type: "save" }); // even bypassing the disabled button
    expect(api.gate.calls.filter((c) => c.method === "update")).toHaveLength(1);
    api.gate.hold = false;
    api.gate.release();
    await waitFor(() => titles(h as Harness).includes("Buy oat milk"));
    // The later typing survived as the next commit's draft.
    await waitFor(() => h?.view<EditorState>("todos:editor")?.save.enabled === true);
    expect(h.view<EditorState>("todos:editor")?.title).toBe("Buy oat milk and bread");
  });

  it("two Saves in one tick are one commit", async () => {
    const api = seed();
    h = await start(workbenchHeadless({ todoApi: api, notifyTimeoutMs: 60_000 }));
    await waitFor(() => titles(h as Harness).length === 3);
    h.dispatch(h.menuAction("New todo…"));
    h.send("todos:editor", { type: "edit", title: "Once" });
    h.send("todos:editor", { type: "save" });
    h.send("todos:editor", { type: "save" });
    await waitFor(() => titles(h as Harness).includes("Once"));
    await tick();
    expect(api.gate.calls.filter((c) => c.method === "add")).toHaveLength(1);
  });

  it("Add commits the input as it was; what is typed during the add stays in the input", async () => {
    const api = seed();
    h = await start(workbenchHeadless({ todoApi: api }));
    await waitFor(() => titles(h as Harness).length === 3);
    h.send("todos:list", { type: "new-title", value: "First" });
    api.gate.hold = true;
    h.dispatch(findAction(list(h)?.toolbar, "Add"));
    h.send("todos:list", { type: "new-title", value: "Second" });
    expect(findAction(list(h)?.toolbar, "Add")).toMatchObject({ enabled: false, running: true });
    h.send("todos:list", { type: "add" }); // refused while running
    api.gate.hold = false;
    api.gate.release();
    await waitFor(() => titles(h as Harness).includes("First"));
    expect(list(h)?.newTitle).toBe("Second");
    expect(api.gate.calls.filter((c) => c.method === "add").map((c) => c.args)).toEqual([
      ["First"],
    ]);
  });

  it("Clear completed removes the todos that were done WHEN ASKED", async () => {
    h = await start(workbenchHeadless({ todoApi: seed(), notifyTimeoutMs: 60_000 }));
    await waitFor(() => titles(h as Harness).length === 3);
    h.dispatch(findAction(list(h)?.toolbar, "Clear completed"));
    expect(h.view<ClearCompletedState>("todos:clear-completed")?.count).toBe(1);
    h.send("todos:list", { type: "toggle-one", id: todoId(h, "Buy milk") });
    await waitFor(() => list(h as Harness)?.todos.find((t) => t.id === "t1")?.done === true);
    h.dispatch(h.view<ClearCompletedState>("todos:clear-completed")?.confirm);
    await waitFor(() => h?.dialogIds().length === 0);
    expect(titles(h)).toEqual(["Buy milk", "Write report"]);
    expect(h.notes().map((n) => n.message)).toContain("Cleared 1 completed todo");
  });

  it("interaction (1) reads the selection at commit time", async () => {
    h = await start(workbenchHeadless({ notifyTimeoutMs: 60_000 }));
    await waitFor(() => contactId(h as Harness, "Ada Lovelace") !== "");
    h.send("contacts:list", { type: "select", id: contactId(h, "Ada Lovelace") });
    const action = h.view<{ actions: { action: { label: string } }[] }>(
      "contacts:details",
    )?.actions;
    const newTodo = findAction(action as never, "New todo for this contact");
    h.dispatch(newTodo);
    h.send("contacts:list", { type: "select", id: contactId(h, "Alan Turing") });
    expect(h.view<EditorState>("todos:editor")?.title).toBe("Ada Lovelace");
  });

  it("an app stopped while a Save is in flight writes nothing when it lands", async () => {
    const api = seed();
    h = await start(workbenchHeadless({ todoApi: api, notifyTimeoutMs: 60_000 }));
    await waitFor(() => titles(h as Harness).length === 3);
    h.dispatch(h.menuAction("New todo…"));
    h.send("todos:editor", { type: "edit", title: "Late" });
    api.gate.hold = true;
    h.dispatch(h.view<EditorState>("todos:editor")?.save);
    const system = h.system;
    await h.stop();
    const atStop = system.stats();
    api.gate.release();
    await tick();
    await tick();
    expect(system.stats()).toEqual({ ...atStop, perActor: {} });
    expect(system.streams.snapshot().filter((s) => s.hasValue)).toEqual([]);
    expect(h.errors()).toEqual([]);
    h = undefined;
  });
});
