import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "hightable/src/HighTable.css";
import { PanelController, PanelModel, PanelsModel, TableModel } from "@fm/app";
import { FM_SELECTION, PanelView, placements, readSelection } from "@fm/ui";
import { Commands } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

/** D2g — internal drags, and the panel the layout cannot place. */

let root: Root | undefined;
let shell: HTMLElement | undefined;

afterEach(async () => {
  root?.unmount();
  await new Promise((r) => setTimeout(r, 0));
  shell?.remove();
  root = shell = undefined;
});

interface Drop {
  files: { path: string }[];
  target: { storage: string; path: string };
  sourcePanelId?: string;
  external: boolean;
}

const buildPanel = async (id: string, path: string, files: Record<string, string>) => {
  const api = new MemFilesApi({ initialFiles: files });
  const panel = new PanelModel(id, "left", `mem://${id}`, path);
  const table = new TableModel();
  const controller = new PanelController(panel, api, new Commands(), () => {});
  panel.onUpdate(() => table.setRows(panel.visible));
  await controller.refresh();
  return { panel, table, api };
};

const mountTwo = async () => {
  const left = await buildPanel("p1", "/src", { "/src/a.txt": "a", "/src/b.txt": "b" });
  const right = await buildPanel("p2", "/dst", { "/dst/keep.txt": "k" });
  const drops: Drop[] = [];

  shell = document.createElement("div");
  shell.style.cssText = "height:600px;width:900px;display:flex;position:relative";
  document.body.appendChild(shell);
  root = createRoot(shell);
  root.render(
    createElement(
      "div",
      { style: { display: "flex", flex: 1, minHeight: 0 } },
      createElement(PanelView, {
        key: "p1",
        panel: left.panel,
        table: left.table,
        onDropFiles: (r: Drop) => drops.push(r),
      }),
      createElement(PanelView, {
        key: "p2",
        panel: right.panel,
        table: right.table,
        onDropFiles: (r: Drop) => drops.push(r),
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 200));
  const panels = [...shell.querySelectorAll(".fm-panel")] as HTMLElement[];
  return { left, right, drops, panels };
};

const drag = (from: HTMLElement, to: HTMLElement) => {
  const dataTransfer = new DataTransfer();
  from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
  to.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer, cancelable: true }));
  to.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer, cancelable: true }));
  return dataTransfer;
};

describe("D2g · internal drag", () => {
  it("carries the selection on a private MIME type, and nothing the OS claims", async () => {
    const { left, panels } = await mountTwo();
    left.table.selected = new Set(["/src/a.txt"]);
    left.table.notify();

    const dataTransfer = drag(panels[0], panels[1]);
    const types = [...dataTransfer.types];

    expect(types).toContain(FM_SELECTION);
    // The two the browser and the desktop would both act on.
    expect(types).not.toContain("text/uri-list");
    expect(types).not.toContain("Files");
    expect(readSelection(dataTransfer)!.files.map((f) => f.path)).toContain("/src/a.txt");
  });

  it("delivers a resolved request to the target panel, not an operation", async () => {
    const { left, drops, panels } = await mountTwo();
    left.table.selected = new Set(["/src/a.txt", "/src/b.txt"]);
    left.table.notify();

    drag(panels[0], panels[1]);

    expect(drops).toHaveLength(1);
    expect(drops[0].external).toBe(false);
    expect(drops[0].sourcePanelId).toBe("p1");
    expect(drops[0].target).toEqual({ storage: "mem://p2", path: "/dst" });
    expect(drops[0].files.map((f) => f.path).sort()).toEqual(["/src/a.txt", "/src/b.txt"]);
  });

  it("falls back to the cursor row when nothing is selected", async () => {
    const { drops, panels } = await mountTwo();
    drag(panels[0], panels[1]);
    expect(drops[0].files).toHaveLength(1);
  });

  it("ignores a drop onto the panel that started it", async () => {
    const { drops, panels } = await mountTwo();
    drag(panels[0], panels[0]);
    expect(drops).toHaveLength(0);
  });

  it("claims the dragover, so the browser does not navigate to the payload", async () => {
    const { panels } = await mountTwo();
    const dataTransfer = new DataTransfer();
    panels[0].dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
    const over = new DragEvent("dragover", { bubbles: true, dataTransfer, cancelable: true });
    panels[1].dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
  });

  it("recognises an OS drop as external, with no internal payload", async () => {
    const { drops, panels } = await mountTwo();
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["hello"], "outside.txt", { type: "text/plain" }));
    panels[1].dispatchEvent(
      new DragEvent("drop", { bubbles: true, dataTransfer, cancelable: true }),
    );

    expect(drops).toHaveLength(1);
    expect(drops[0].external).toBe(true);
    expect(drops[0].sourcePanelId).toBeUndefined();
    expect(drops[0].target).toEqual({ storage: "mem://p2", path: "/dst" });
  });
});

describe("D2g · the panel the layout cannot place", () => {
  const panelsWith = (slotNames: string[], count: number) => {
    const model = new PanelsModel({ slots: slotNames });
    for (let i = 0; i < count; i++) model.add({ storage: "mem://a", path: `/p${i}` });
    return model;
  };

  it("places every panel that has a slot the layout knows", () => {
    const model = panelsWith(["left", "right"], 2);
    const placed = placements(model, {
      left: document.createElement("div"),
      right: document.createElement("div"),
    });
    expect(placed.every((p) => !p.floating)).toBe(true);
    expect(placed.map((p) => p.slot)).toEqual(["left", "right"]);
  });

  it("floats a panel the layout has no slot for, rather than dropping it", () => {
    const model = panelsWith(["left"], 2); // the second gets slot: undefined
    const placed = placements(model, { left: document.createElement("div") });
    expect(placed).toHaveLength(2);
    expect(placed.filter((p) => p.floating)).toHaveLength(1);
  });

  it("floats a panel whose slot the layout does not declare", () => {
    // The slot exists on the model but this layout does not offer it — still a
    // view-layer decision, not an error handed back to a controller.
    const model = panelsWith(["aux-1"], 1);
    const placed = placements(model, { left: document.createElement("div") });
    expect(placed[0].floating).toBe(true);
  });

  it("floats only one at a time", () => {
    const model = panelsWith(["left"], 4);
    const placed = placements(model, { left: document.createElement("div") });
    expect(placed.filter((p) => p.floating)).toHaveLength(1);
    expect(placed.filter((p) => !p.floating && p.slot === undefined)).toHaveLength(2);
  });
});
