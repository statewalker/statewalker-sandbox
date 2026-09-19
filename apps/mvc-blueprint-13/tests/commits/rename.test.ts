import type { TitleFormView } from "@p5/todos/api";
import { afterEach, describe, expect, it } from "vitest";
import { dialog, type Running, start, until, workbenchHeadless } from "../support/harness.js";
import { selectionAction, titles, todoList } from "../support/scenarios.js";

describe("Rename a todo (§14.6)", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  it("enabled with exactly one selected; renames at commit time; empty is refused with a form error", async () => {
    r = await start(workbenchHeadless);
    await until(() => titles(r as Running).length === 3);
    const list = todoList(r);
    const rename = selectionAction(list, "Rename…");
    expect(rename.getState().enabled).toBe(false);
    list.select(["t1", "t2"]);
    expect(rename.getState().enabled).toBe(false);
    list.select(["t1"]);
    expect(rename.getState().enabled).toBe(true);
    rename.submit();
    await until(() => dialog(r?.slots as never, "todos:rename") !== undefined);
    const form = dialog<TitleFormView>(r.slots, "todos:rename")?.model as TitleFormView;
    expect(form.getDraft().title).toBe("Buy milk");

    form.editField("title", "  ");
    form.save.submit();
    await until(() => form.getStatus().errors.form !== undefined);
    expect(form.getStatus().errors.form).toBe("Title is required");
    expect(dialog(r.slots, "todos:rename")).toBeDefined();

    form.editField("title", "Buy oat milk");
    form.save.submit();
    form.editField("title", "typed after the commit");
    await until(() => dialog(r?.slots as never, "todos:rename") === undefined);
    expect(titles(r)).toContain("Buy oat milk");
  });
});
