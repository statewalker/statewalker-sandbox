import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import "hightable/src/HighTable.css";
import { Commands } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { PanelController, PanelModel, TableModel } from "@fm/app";
import { PanelView } from "@fm/ui";

/** D2f — the panel component, driven only by models. */

let root: Root | undefined;
let shell: HTMLElement | undefined;
let panel: PanelModel;
let table: TableModel;
let controller: PanelController;
let api: MemFilesApi;

const settle = async () => {
  await controller.settled();
  await new Promise((r) => setTimeout(r, 60));
};

const build = async (files: Record<string, string>) => {
  api = new MemFilesApi({ initialFiles: files });
  panel = new PanelModel("p1", "left", "mem://a", "/dir");
  table = new TableModel();
  controller = new PanelController(panel, api, new Commands(), () => {});
  // The controller writes the panel; this is the one line that keeps the table
  // in step with the projection.
  panel.onUpdate(() => table.setRows(panel.visible));
  await controller.refresh();

  shell = document.createElement("div");
  shell.style.cssText = "height:600px;width:800px;display:flex;flex-direction:column";
  document.body.appendChild(shell);
  root = createRoot(shell);
  root.render(createElement(PanelView, { panel, table }));
  await new Promise((r) => setTimeout(r, 200));
  return shell.querySelector(".fm-panel") as HTMLElement;
};

const press = async (el: HTMLElement, key: string) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  await settle();
};

const names = () =>
  [...(shell?.querySelectorAll("tbody tr") ?? [])].map(
    (tr) => tr.querySelector("td:nth-child(2)")?.textContent ?? "",
  );

afterEach(async () => {
  // Order matters, and so does the wait. Removing the shell first — or
  // unmounting without letting the removal settle — leaves the grid observing
  // a DETACHED node whose height is 0. A zero-height grid concludes that every
  // row is visible, and at 100k it throws. Teardown is part of the contract.
  root?.unmount();
  await new Promise((r) => setTimeout(r, 0));
  shell?.remove();
  root = shell = undefined;
});

describe("D2f · the panel component", () => {
  it("renders the listing and the breadcrumb from the models", async () => {
    const el = await build({ "/dir/a.txt": "a", "/dir/b.txt": "b", "/dir/sub/x.txt": "x" });
    expect(el.querySelector(".fm-panel-breadcrumb")!.textContent).toBe("/dir");
    expect(el.dataset.rows).toBe("3");
    expect(names()).toContain("a.txt");
  });

  it("moves the cursor on arrow keys, through the model", async () => {
    const el = await build({ "/dir/a.txt": "a", "/dir/b.txt": "b" });
    expect(el.dataset.cursor).toBe("0");
    await press(el, "ArrowDown");
    expect(table.cursor).toBe(1);
    expect(el.dataset.cursor).toBe("1"); // the DOM followed the model, not the event
    await press(el, "ArrowUp");
    expect(table.cursor).toBe(0);
  });

  it("does not run off either end of the listing", async () => {
    const el = await build({ "/dir/a.txt": "a", "/dir/b.txt": "b" });
    await press(el, "ArrowUp");
    expect(table.cursor).toBe(0);
    await press(el, "ArrowDown");
    await press(el, "ArrowDown");
    await press(el, "ArrowDown");
    expect(table.cursor).toBe(1);
  });

  it("selects by path, and the selection survives a listing that reorders", async () => {
    const el = await build({ "/dir/b.txt": "b", "/dir/c.txt": "c" });
    await press(el, "ArrowDown"); // onto b.txt (after the sort)
    const chosen = table.getRowKey(table.cursor)!;
    await press(el, " ");
    expect([...table.selected]).toEqual([chosen]);

    // A copy lands a file that sorts ahead of the selected one — the exact
    // case that an index-keyed selection gets wrong.
    await api.write("/dir/a-new.txt", [new TextEncoder().encode("n")]);
    await controller.refresh();
    await settle();

    expect([...table.selected]).toEqual([chosen]);
    const stillSelected = [...Array(table.rowCount).keys()].filter((r) => table.isSelected(r));
    expect(stillSelected.map((r) => table.getRowKey(r))).toEqual([chosen]);
  });

  it("states a navigation INTENT on Enter; the controller performs it", async () => {
    const el = await build({ "/dir/sub/x.txt": "x", "/dir/a.txt": "a" });
    expect(table.getRow(0)!.kind).toBe("directory"); // directories sort first
    await press(el, "Enter");

    expect(panel.input.requestedPath).toBe("/dir/sub");
    expect(panel.path).toBe("/dir/sub"); // the controller reacted
    await new Promise((r) => setTimeout(r, 120));
    expect(el.dataset.path).toBe("/dir/sub");
    expect(names()).toContain("x.txt");
  });

  it("ignores Enter on a file", async () => {
    const el = await build({ "/dir/a.txt": "a" });
    await press(el, "Enter");
    expect(panel.path).toBe("/dir");
  });

  it("goes back on Backspace, through the input counter", async () => {
    const el = await build({ "/dir/sub/x.txt": "x", "/dir/a.txt": "a" });
    await press(el, "Enter");
    expect(panel.path).toBe("/dir/sub");
    await press(el, "Backspace");
    expect(panel.path).toBe("/dir");
  });

  it("shows staleness and errors from the model", async () => {
    const el = await build({ "/dir/a.txt": "a" });
    expect(el.dataset.stale).toBe("false");

    panel.stale = true;
    panel.error = "connection lost";
    panel.notify();
    await new Promise((r) => setTimeout(r, 60));

    expect(el.dataset.stale).toBe("true");
    expect(el.querySelector("[role=alert]")!.textContent).toBe("connection lost");
  });

  it("keeps the DOM bounded at 100k entries inside the real shell", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 100_000; i++) files[`/dir/f${String(i).padStart(6, "0")}.txt`] = "x";
    await build(files);
    // The permanent guard: any future layout change that breaks the flex chain
    // puts 100 000 rows in the DOM, and this fails.
    expect(table.rowCount).toBe(100_000);
    const rendered = shell!.querySelectorAll("tbody tr").length;
    // BOTH bounds. "fewer than 200" alone passes when the grid refused to
    // render at all — which is precisely the failure this guard exists to
    // catch, and which it silently permitted until this line was added.
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
  }, 60_000);
});
