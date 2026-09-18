import { describe, expect, it } from "vitest";
import { workbenchHeadless } from "../../src/apps/index.js";
import type { RenameState } from "../../src/bundles/todos/api/index.js";
import { gatedTodoApi } from "../support/gated-api.js";
import { findAction, start, waitFor } from "../support/headless.js";
import { list, titles } from "./scenario.js";

describe("Rename a todo (§14.6)", () => {
  it("enabled with exactly one selected; renames at commit time; empty is a form error", async () => {
    const api = gatedTodoApi([
      { id: "t1", title: "Buy milk", done: false },
      { id: "t2", title: "Write report", done: false },
    ]);
    const h = await start(workbenchHeadless({ todoApi: api }));
    await waitFor(() => titles(h).length === 2);
    const rename = () => findAction(list(h)?.selectionActions, "Rename…");
    expect(rename()?.enabled).toBe(false);
    h.send("todos:list", { type: "select", id: "t1", additive: false });
    h.send("todos:list", { type: "select", id: "t2", additive: true });
    expect(rename()?.enabled).toBe(false);
    h.send("todos:list", { type: "select", id: "t2", additive: true });
    expect(rename()?.enabled).toBe(true);
    h.dispatch(rename());
    expect(h.dialogIds()).toEqual(["todos:rename"]);
    expect(h.view<RenameState>("todos:rename")?.title).toBe("Buy milk");
    h.send("todos:rename", { type: "edit", title: "  " });
    h.dispatch(h.view<RenameState>("todos:rename")?.rename);
    expect(h.view<RenameState>("todos:rename")?.error).toBe("Title is required");
    h.send("todos:rename", { type: "edit", title: "Buy oat milk" });
    api.gate.hold = true;
    h.dispatch(h.view<RenameState>("todos:rename")?.rename);
    h.send("todos:rename", { type: "edit", title: "typed after" });
    api.gate.hold = false;
    api.gate.release();
    await waitFor(() => h.dialogIds().length === 0);
    expect(titles(h)).toEqual(["Buy oat milk", "Write report"]);
    expect(h.errors()).toEqual([]);
    await h.stop();
  });
});
