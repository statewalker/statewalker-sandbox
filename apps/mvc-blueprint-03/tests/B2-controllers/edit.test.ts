import { notify } from "@notifications/commands";
import { panelsSlot } from "@sys/extension-points";
import { createEditModel, TodoEditController, todoEditKind, todosEditOpen } from "@todos/edit";
import { todosChanged } from "@todos/events";
import { describe, expect, it, vi } from "vitest";
import { newTestContext, settle } from "../support/context.js";

const milk = { id: "t1", title: "Buy milk", done: false };

describe("B2 · edit model", () => {
  it("starts from the todo: a clean, valid draft, Save disabled, Cancel enabled", () => {
    const m = createEditModel(milk);
    expect(m.view.details.getTodo()).toEqual(milk);
    expect(m.view.form.getDraft()).toEqual({ title: "Buy milk", done: false });
    expect(m.view.form.getStatus()).toEqual({ dirty: false, valid: true });
    expect(m.view.form.actions.save.getState()).toMatchObject({
      label: "Save",
      icon: "save",
      enabled: false,
    });
    expect(m.view.form.actions.cancel.getState()).toMatchObject({
      label: "Cancel",
      icon: "x",
      enabled: true,
    });
  });

  it("editing makes the draft dirty and Save enabled; a blank title is invalid", () => {
    const m = createEditModel(milk);
    m.view.form.setTitle("Buy oat milk");
    expect(m.view.form.getStatus()).toEqual({ dirty: true, valid: true });
    expect(m.view.form.actions.save.getState().enabled).toBe(true);
    m.view.form.setTitle("   ");
    expect(m.view.form.getStatus()).toEqual({ dirty: true, valid: false });
    expect(m.view.form.actions.save.getState().enabled).toBe(false);
    m.view.form.setTitle("Buy milk");
    m.view.form.setDone(true);
    expect(m.view.form.getStatus()).toEqual({ dirty: true, valid: true });
  });

  it("reportError shows on the status; markSaved makes the saved todo the new baseline", () => {
    const m = createEditModel(milk);
    m.view.form.setTitle("Buy bread");
    m.control.reportError("save failed: disk full");
    expect(m.view.form.getStatus()).toEqual({
      dirty: true,
      valid: true,
      error: "save failed: disk full",
    });
    m.control.markSaved({ id: "t1", title: "Buy bread", done: false });
    expect(m.view.details.getTodo().title).toBe("Buy bread");
    expect(m.view.form.getStatus()).toEqual({ dirty: false, valid: true });
  });

  it("after dispose: setters are no-ops and both actions are disabled", () => {
    const m = createEditModel(milk);
    m.dispose();
    m.view.form.setTitle("late");
    expect(m.view.form.getDraft().title).toBe("Buy milk");
    expect(m.view.form.actions.cancel.getState().enabled).toBe(false);
  });
});

describe("B2 · edit controller", () => {
  async function start() {
    const env = newTestContext([milk, { id: "t2", title: "Walk dog", done: true }]);
    const controller = new TodoEditController();
    controller.activate(env.ctx);
    const toasts: { text: string; level: string }[] = [];
    env.commands.listen(notify, (cmd) => {
      toasts.push(cmd.payload);
      return Promise.resolve({ shown: true });
    });
    const changed: string[] = [];
    env.commands.listen(todosChanged, (cmd) => {
      changed.push(cmd.payload.source);
    });
    return { ...env, controller, toasts, changed };
  }

  it("open shows the editor as a side panel and resolves opened", async () => {
    const { commands, slots, controller } = await start();
    await expect(commands.call(todosEditOpen, { id: "t1" }).promise).resolves.toEqual({
      opened: true,
    });
    const panel = slots.get(panelsSlot, "todos:edit");
    expect(panel).toMatchObject({
      kind: todoEditKind,
      title: 'Edit "Buy milk"',
      placement: "side",
    });
    expect(panel?.model).toBe(controller.current?.view);
    await controller.dispose();
  });

  it("open of an unknown todo rejects and shows nothing", async () => {
    const { commands, slots, controller } = await start();
    await expect(commands.call(todosEditOpen, { id: "t9" }).promise).rejects.toMatchObject({
      kind: "listener-threw",
    });
    expect(slots.get(panelsSlot, "todos:edit")).toBeNull();
    await controller.dispose();
  });

  it("Save updates the todo, closes the editor, broadcasts the change and says so", async () => {
    const { api, commands, slots, recorder, controller, toasts, changed } = await start();
    await commands.call(todosEditOpen, { id: "t1" }).promise;
    const form = controller.current?.view.form;
    form?.setTitle("  Buy oat milk ");
    form?.setDone(true);
    form?.actions.save.submit();
    await settle();
    expect((await api.list()).find((t) => t.id === "t1")).toEqual({
      id: "t1",
      title: "Buy oat milk",
      done: true,
    });
    expect(slots.get(panelsSlot, "todos:edit")).toBeNull();
    expect(controller.current).toBeUndefined();
    expect(changed).toEqual(["todos.edit"]);
    expect(toasts).toEqual([{ text: "Saved", level: "info" }]);
    expect(recorder.calls).toContainEqual({
      level: "info",
      args: ["action:save", { id: "t1" }],
      metadata: { module: "todos.edit" },
    });
    await controller.dispose();
  });

  it("Save acts on the draft as submitted, not as edited later in the same tick", async () => {
    const { api, commands, controller } = await start();
    await commands.call(todosEditOpen, { id: "t1" }).promise;
    const form = controller.current?.view.form;
    form?.setTitle("Buy oat milk");
    form?.actions.save.submit();
    form?.setTitle("later edit");
    await settle();
    expect((await api.list()).find((t) => t.id === "t1")).toEqual({
      id: "t1",
      title: "Buy oat milk",
      done: false,
    });
    await controller.dispose();
  });

  it("a failing Save keeps the editor and the draft, shows the error and an error toast", async () => {
    const { api, commands, slots, controller, toasts, changed } = await start();
    await commands.call(todosEditOpen, { id: "t1" }).promise;
    const form = controller.current?.view.form;
    api.fail("update", "disk full");
    form?.setTitle("Buy bread");
    form?.actions.save.submit();
    await settle();
    expect(slots.get(panelsSlot, "todos:edit")).not.toBeNull();
    expect(form?.getDraft().title).toBe("Buy bread");
    expect(form?.getStatus()).toEqual({
      dirty: true,
      valid: true,
      error: "save failed: disk full",
    });
    expect(form?.actions.save.getState()).toMatchObject({ running: false, enabled: true });
    expect(toasts).toEqual([{ text: "save failed: disk full", level: "error" }]);
    expect(changed).toEqual([]);
    await controller.dispose();
  });

  it("Cancel closes the editor without saving", async () => {
    const { api, commands, slots, controller } = await start();
    await commands.call(todosEditOpen, { id: "t1" }).promise;
    controller.current?.view.form.setTitle("never saved");
    controller.current?.view.form.actions.cancel.submit();
    await settle();
    expect(slots.get(panelsSlot, "todos:edit")).toBeNull();
    expect(api.calls).not.toContain("update");
    await controller.dispose();
  });

  it("opening while an editor is open replaces it", async () => {
    const { commands, slots, controller } = await start();
    await commands.call(todosEditOpen, { id: "t1" }).promise;
    const first = controller.current;
    await Promise.all([
      commands.call(todosEditOpen, { id: "t2" }).promise,
      commands.call(todosEditOpen, { id: "t2" }).promise,
    ]);
    expect(controller.current).not.toBe(first);
    expect(slots.get(panelsSlot, "todos:edit")?.title).toBe('Edit "Walk dog"');
    expect(first?.view.form.actions.save.getState().enabled).toBe(false);
    await controller.dispose();
  });

  it("dispose withdraws an open editor", async () => {
    const { commands, slots, controller } = await start();
    await commands.call(todosEditOpen, { id: "t1" }).promise;
    await controller.dispose();
    expect(slots.get(panelsSlot, "todos:edit")).toBeNull();
    const spy = vi.fn();
    commands.call(todosEditOpen, { id: "t1" }).promise.catch(spy);
    await settle();
    expect(spy).toHaveBeenCalled();
  });
});
