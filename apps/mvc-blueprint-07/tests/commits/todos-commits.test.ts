import { afterEach, describe, expect, it } from "vitest";
import { type Probe, start, tick } from "../support/headless.js";
import {
  confirmDialog,
  editor,
  list,
  openTodoEditor,
  recordsOf,
  selectionAction,
  titles,
  toolbarAction,
} from "../support/todos.js";

let app: Probe;
afterEach(async () => app?.stop());

/** A validator we can hold open: the save's first step is async. */
function gate() {
  const waiting: Array<() => void> = [];
  return {
    validator: (title: string) =>
      new Promise<string | undefined>((resolve) =>
        waiting.push(() => resolve(title.trim() === "" ? "Title is required" : undefined)),
      ),
    releaseAll: () => {
      for (const release of waiting.splice(0)) release();
    },
    get held() {
      return waiting.length;
    },
  };
}

describe("commit time (§10.1): the committed value is the record's payload", () => {
  it("edit, submit, keep typing while the save runs — the store receives the value at submit", async () => {
    app = await start(undefined, { todoDelay: 10 });
    const form = openTodoEditor(app, "t1");
    form.editTitle("Buy oat milk");
    form.save.submit();
    form.editTitle("typed after submit"); // belongs to the next commit
    await app.log.idle();
    expect(app.todoApi.calls.filter((c) => c.op === "update")).toEqual([
      { op: "update", args: ["t1", { title: "Buy oat milk" }] },
    ]);
    // where the committed value came from: the save record, captured at submit
    expect(recordsOf(app, "todos.edit:save")[0]).toMatchObject({
      payload: { session: "todos:editor:t1", title: "Buy oat milk" },
    });
    expect(titles(app)[0]).toBe("Buy oat milk");
    expect(editor(app, "t1")).toBeUndefined(); // closed on success
  });

  it("a multi-step commit (async validation, then the mutation) still acts on the submitted value", async () => {
    const g = gate();
    app = await start(undefined, { validator: g.validator });
    const form = openTodoEditor(app, "t2");
    form.editTitle("Final report");
    form.save.submit();
    form.editTitle("changed during validation");
    expect(g.held).toBe(1);
    g.releaseAll();
    await app.log.idle();
    expect(app.todoApi.calls.find((c) => c.op === "update")?.args).toEqual([
      "t2",
      { title: "Final report" },
    ]);
  });
});

describe("never silently lost (§10.2): the log answers queue-vs-disable", () => {
  it("two submits in one tick are one commit; the second is visibly refused (running)", async () => {
    const g = gate();
    app = await start(undefined, { validator: g.validator });
    const form = openTodoEditor(app, "t1");
    form.editTitle("Once");
    form.save.submit();
    expect(form.save.getState().running).toBe(true);
    form.save.submit();
    expect(recordsOf(app, "todos.edit:save")).toHaveLength(1);
    g.releaseAll();
    await app.log.idle();
    expect(app.todoApi.calls.filter((c) => c.op === "update")).toHaveLength(1);
  });

  it("an event-edge action (Add) appends every submit: two commits in one tick, both honoured", async () => {
    app = await start();
    const add = toolbarAction(app, "Add");
    list(app).editNewTitle("First");
    add.submit();
    expect(list(app).getNewTitle()).toBe(""); // the input is reset as a whole after its commit
    list(app).editNewTitle("Second");
    add.submit();
    expect(add.getState().running).toBe(true);
    await app.log.idle();
    expect(titles(app).slice(-2)).toEqual(["First", "Second"]);
    expect(add.getState().running).toBe(false);
  });

  it("a failing save is recorded as an outcome; the form shows it and stays open", async () => {
    app = await start();
    const form = openTodoEditor(app, "t1");
    form.editTitle("   ");
    form.save.submit();
    await app.log.idle();
    expect(form.getStatus().error).toBe("Title is required");
    expect(editor(app, "t1")).toBe(form);
    const outcome = app.log
      .records()
      .find((r) => r.kind === "outcome" && r.type === "todos.edit:save");
    expect(outcome).toMatchObject({ ok: false, error: "Title is required", origin: "todos.edit" });
    form.editTitle("Fixed");
    form.save.submit();
    await app.log.idle();
    expect(titles(app)[0]).toBe("Fixed");
  });
});

describe("multi-step races (§10.3)", () => {
  it("a delete landing during validation fails the save visibly; nothing is resurrected", async () => {
    const g = gate();
    app = await start(undefined, { validator: g.validator });
    const form = openTodoEditor(app, "t1");
    form.editTitle("Too late");
    form.save.submit();
    selectionAction(app, "Delete").submit(); // t1 is still selected
    await tick(5);
    expect(titles(app)).not.toContain("Buy milk");
    g.releaseAll();
    await app.log.idle();
    expect(form.getStatus().error).toBe("This todo was deleted while saving");
    expect(app.todoApi.calls.some((c) => c.op === "update")).toBe(false);
    expect(titles(app)).not.toContain("Too late");
  });

  it("cancel during validation: the save never reaches the store", async () => {
    const g = gate();
    app = await start(undefined, { validator: g.validator });
    const form = openTodoEditor(app, "t1");
    form.editTitle("Never");
    form.save.submit();
    form.cancel.submit();
    expect(editor(app, "t1")).toBeUndefined();
    g.releaseAll();
    await app.log.idle();
    expect(app.todoApi.calls.some((c) => c.op === "update")).toBe(false);
    const outcome = app.log
      .records()
      .find((r) => r.kind === "outcome" && r.type === "todos.edit:save");
    expect(outcome).toMatchObject({ ok: false });
  });

  it("a toggle racing a rename: both patches land, in log order", async () => {
    const g = gate();
    app = await start(undefined, { validator: g.validator });
    const form = openTodoEditor(app, "t1");
    form.editTitle("Buy bread");
    form.save.submit();
    list(app).toggle("t1");
    await tick(5);
    g.releaseAll();
    await app.log.idle();
    expect(list(app).getItems()[0]).toMatchObject({ title: "Buy bread", done: true });
  });
});

describe("clear completed acts on the question it asked", () => {
  it("removes the todos done WHEN ASKED, and notifies", async () => {
    app = await start();
    app.menu("Clear completed")?.submit();
    const dialog = confirmDialog(app);
    expect(dialog?.getState().count).toBe(1);
    list(app).toggle("t1"); // done after the question
    await app.log.idle();
    dialog?.confirm.submit();
    await app.log.idle();
    expect(titles(app)).toEqual(["Buy milk", "Write report"]);
    expect(confirmDialog(app)).toBeUndefined();
    expect(app.toasts()).toEqual([{ message: "Removed 1 completed todo", tone: "success" }]);
  });
});

describe("compose", () => {
  it("New todo… opens the editor in create mode; Add adds and closes", async () => {
    app = await start();
    app.menu("New todo…")?.submit();
    const form = editor(app, "new");
    expect(form?.getStatus().mode).toBe("create");
    form?.editTitle("Water plants");
    form?.save.submit();
    await app.log.idle();
    expect(titles(app)).toContain("Water plants");
    expect(app.header()).toEqual(["3 open todos"]);
    expect(editor(app, "new")).toBeUndefined();
  });
});
