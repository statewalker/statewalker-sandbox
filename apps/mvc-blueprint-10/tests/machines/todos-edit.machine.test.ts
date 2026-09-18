import { describe, expect, it } from "vitest";
import { editorChart } from "../../src/bundles/todos.edit/machine.js";
import { drive, trace } from "./trace.js";

describe("todos.edit chart (no DOM, no kernel)", () => {
  it("edit → save → failed → save → saved", async () => {
    const { machine } = await trace(editorChart);
    expect(machine.states()).toEqual(["todos.edit", "closed"]);
    expect(await drive(machine, "edit", "save", "failed", "save", "saved")).toEqual([
      "todos.edit/open/editing",
      "todos.edit/open/saving",
      "todos.edit/open/editing",
      "todos.edit/open/saving",
      "todos.edit/closed",
    ]);
  });

  it("Save is refused while saving: the second save is dropped, nothing is re-entered", async () => {
    const { machine, log } = await trace(editorChart);
    await drive(machine, "compose", "save");
    log.length = 0;
    expect(await drive(machine, "save")).toEqual(["todos.edit/open/saving"]);
    expect(log).toEqual([]);
  });

  it("two same-tick saves are one transition", async () => {
    const { machine, log } = await trace(editorChart);
    await drive(machine, "edit");
    log.length = 0;
    machine.send("save");
    machine.send("save");
    await machine.idle();
    expect(log).toEqual(["-editing", "+saving(save)"]);
  });

  it("a replacing edit while saving leaves saving and opens a new session", async () => {
    const { machine, log } = await trace(editorChart);
    await drive(machine, "edit", "save");
    log.length = 0;
    expect(await drive(machine, "edit")).toEqual(["todos.edit/open/editing"]);
    expect(log).toEqual(["-saving", "-open", "+open(edit)", "+editing(edit)"]);
  });

  it("cancel closes from any open state; events with no rule are dropped", async () => {
    const { machine } = await trace(editorChart);
    expect(await drive(machine, "save", "saved", "cancel")).toEqual([
      "todos.edit/closed",
      "todos.edit/closed",
      "todos.edit/closed",
    ]);
    expect(await drive(machine, "edit", "save", "cancel")).toEqual([
      "todos.edit/open/editing",
      "todos.edit/open/saving",
      "todos.edit/closed",
    ]);
  });

  it("stop unwinds inner first and later events are ignored", async () => {
    const { machine, log } = await trace(editorChart);
    await drive(machine, "edit", "save");
    log.length = 0;
    await machine.stop();
    machine.send("saved");
    await machine.idle();
    expect(log).toEqual(["-saving", "-open", "-todos.edit"]);
    expect(machine.states()).toEqual([]);
  });
});
