import { dialogsSlot, panelsSlot, runningOperationsSlot } from "@sys";
import { TodoController } from "@todo/app";
import { registerTodoCommands, type Todo, todosSummary } from "@todo/core";
import { describe, expect, it } from "vitest";
import { newTestContext, settle, tick } from "../support/context.js";

const todo = (id: string, title: string, done = false): Todo => ({ id, title, done });

function boot(rows: Todo[] = [todo("1", "seed")]) {
  const t = newTestContext(rows);
  registerTodoCommands(t.commands, t.api);
  const controller = new TodoController({ sampleDelayMs: 1 });
  controller.activate(t.ctx);
  const events = () =>
    t.recorder.calls
      .filter((c) => c.metadata.module === "todos")
      .map((c) => ({ event: c.args[0], data: c.args[1] }));
  return { ...t, controller, events };
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not reached");
    await tick(2);
  }
}

describe("B2 · todo controller", () => {
  it("publishes its list panel and loads the todos on activation", async () => {
    const { controller, slots } = boot();
    const panel = slots.get(panelsSlot, "todos:list");
    expect(panel?.kind.id).toBe("todos:list");
    expect(panel?.placement).toBe("main");
    expect(panel?.model).toBe(controller.model.view);
    await settle();
    expect(controller.model.view.getVisible().map((t) => t.id)).toEqual(["1"]);
    await controller.dispose();
  });

  it("logs todos:created only after the add landed — a rejected add logs nothing", async () => {
    const { controller, events } = boot();
    await settle();
    controller.model.view.queueSubmit("milk");
    controller.model.view.queueSubmit("");
    await settle();
    expect(controller.model.view.getVisible().map((t) => t.title)).toEqual(["seed", "milk"]);
    expect(events()).toEqual([
      { event: "todos:created", data: { id: expect.any(String), title: "milk" } },
    ]);
    expect(controller.model.view.getOutcome()).toMatch(/^add "" failed/);
    await controller.dispose();
  });

  it("logs closed, reopened and removed — removal carries whether the todo was done", async () => {
    const { controller, events } = boot([todo("1", "a"), todo("2", "b", true)]);
    await settle();
    controller.model.view.requestToggle("1");
    await settle();
    controller.model.view.requestToggle("1");
    await settle();
    controller.model.view.requestRemove("2");
    await settle();
    expect(events()).toEqual([
      { event: "todos:closed", data: { id: "1" } },
      { event: "todos:reopened", data: { id: "1" } },
      { event: "todos:removed", data: { id: "2", done: true } },
    ]);
    await controller.dispose();
  });

  it("a toggle and a removal landing in the SAME pass log the removal with the fresh done state", async () => {
    const { controller, events } = boot([todo("1", "open", false)]);
    await settle();
    // No settle between these two: both intents land in the reconcile pass triggered
    // by the first one, so the model has not been reloaded when the removal runs.
    controller.model.view.requestToggle("1");
    controller.model.view.requestRemove("1");
    await settle();
    expect(events()).toContainEqual({ event: "todos:removed", data: { id: "1", done: true } });
    await controller.dispose();
  });

  it("clear completed publishes ONE dialog for two presses and does not block other intents while it is open", async () => {
    const { controller, slots, api, events } = boot([todo("1", "open"), todo("2", "done", true)]);
    await settle();
    controller.model.view.requestClearCompleted();
    controller.model.view.requestClearCompleted();
    await settle();
    const open = slots.getSnapshot(dialogsSlot);
    expect(open).toHaveLength(1);
    const dialog = open[0].model as { getQuestion(): string; answer(c: boolean): void };
    expect(dialog.getQuestion()).toBe("Clear 1 completed todo?");

    controller.model.view.queueSubmit("while the dialog is open");
    await settle();
    expect(
      controller.model.view.getVisible().map((t) => t.title),
      "the loop kept working",
    ).toContain("while the dialog is open");
    expect(slots.getSnapshot(dialogsSlot), "the dialog is still open").toHaveLength(1);

    dialog.answer(true);
    await settle();
    expect(slots.getSnapshot(dialogsSlot)).toHaveLength(0);
    expect(api.calls).toContain("clearCompleted");
    expect(events()).toContainEqual({ event: "todos:cleared", data: { count: 1 } });
    expect(controller.model.view.getVisible().map((t) => t.title)).not.toContain("done");
    await controller.dispose();
  });

  it("a declined question clears nothing, and consumes the presses made before the answer", async () => {
    const { controller, slots, api } = boot([todo("2", "done", true)]);
    const asked = new Set<object>();
    slots.observe(dialogsSlot, (items) => {
      for (const item of items) asked.add(item);
    });
    await settle();
    controller.model.view.requestClearCompleted();
    await settle();
    // A second press while the question is open: the answer must consume it too.
    controller.model.view.requestClearCompleted();
    await settle();
    expect(asked, "one question for both presses").toHaveProperty("size", 1);
    (slots.getSnapshot(dialogsSlot)[0].model as { answer(c: boolean): void }).answer(false);
    await settle();
    expect(slots.getSnapshot(dialogsSlot)).toHaveLength(0);
    expect(api.calls).not.toContain("clearCompleted");
    // An unrelated intent runs a pass: a declined question must not come back with it.
    controller.model.view.queueSubmit("unrelated");
    await settle();
    expect(controller.model.view.getVisible().map((t) => t.title)).toContain("unrelated");
    expect(slots.getSnapshot(dialogsSlot), "the declined question is not asked again").toHaveLength(
      0,
    );
    expect(asked, "no new dialog appeared").toHaveProperty("size", 1);
    controller.model.view.requestClearCompleted();
    await settle();
    expect(slots.getSnapshot(dialogsSlot), "a new press asks again").toHaveLength(1);
    await controller.dispose();
  });

  it("with nothing completed, a press asks nothing", async () => {
    const { controller, slots } = boot([todo("1", "open")]);
    await settle();
    controller.model.view.requestClearCompleted();
    await settle();
    expect(slots.getSnapshot(dialogsSlot)).toHaveLength(0);
    await controller.dispose();
  });

  it("answers todos:summary", async () => {
    const { controller, commands } = boot([todo("1", "a"), todo("2", "b", true)]);
    await expect(commands.call(todosSummary, {}).promise).resolves.toEqual({ total: 2, done: 1 });
    await controller.dispose();
  });

  it("sample activity contributes a running operation, advances it, and removes it when done", async () => {
    const { controller, slots, events } = boot([]);
    await settle();
    const seen: number[] = [];
    slots.observe(runningOperationsSlot, (ops) => {
      for (const op of ops) op.onProgressUpdate(() => seen.push(op.getProgress().done));
    });
    controller.model.view.requestSampleTodos(3);
    await until(() => slots.getSnapshot(runningOperationsSlot).length === 1);
    await until(() => slots.getSnapshot(runningOperationsSlot).length === 0);
    await settle();
    expect(seen).toContain(3);
    expect(
      events()
        .filter((e) => e.event === "todos:created")
        .map((e) => (e.data as { title: string }).title),
    ).toEqual(["Sample todo 1", "Sample todo 2", "Sample todo 3"]);
    expect(controller.model.view.getVisible()).toHaveLength(3);
    await controller.dispose();
  });

  it("dispose withdraws the panel, any open dialog, and the summary handler", async () => {
    const { controller, slots, commands } = boot([todo("2", "done", true)]);
    await settle();
    controller.model.view.requestClearCompleted();
    await settle();
    await controller.dispose();
    expect(slots.get(panelsSlot, "todos:list")).toBeNull();
    expect(slots.getSnapshot(dialogsSlot)).toHaveLength(0);
    await expect(commands.call(todosSummary, {}).promise).rejects.toMatchObject({
      kind: "no-handlers",
    });
  });

  it("dispose while a pass is in flight never lets a dialog reach ui:dialogs", async () => {
    const { controller, slots } = boot([todo("1", "done", true)]);
    await settle();
    controller.model.view.queueSubmit("x");
    controller.model.view.requestClearCompleted();
    // Let the reconcile pass's microtask start and suspend on its first internal
    // await (inside `_add`, awaiting the add command) — this is "in flight": the
    // pass has already begun but has not reached `_reload`/`_clearStep` yet.
    await Promise.resolve();
    await controller.dispose();
    await settle();
    expect(slots.getSnapshot(dialogsSlot), "dialogs at dispose 1 after settle 1").toHaveLength(0);
  });
});
