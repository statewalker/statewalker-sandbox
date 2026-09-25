import { expectReplacedNotMutated, PanelController, PanelModel, TableModel } from "@fm/app";
import { Commands } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/** D2a — the table is driven by a model, and the model keys on paths. */

const listing = async (api: MemFilesApi, path: string) => {
  const model = new PanelModel("p1", "left", "mem://a", path);
  const controller = new PanelController(model, api, new Commands(), () => {});
  await controller.refresh();
  return { model, controller };
};

describe("D2a · TableModel", () => {
  let api: MemFilesApi;
  let table: TableModel;

  beforeEach(async () => {
    api = new MemFilesApi({
      initialFiles: { "/dir/a.txt": "aaa", "/dir/b.txt": "b", "/dir/sub/x.txt": "x" },
    });
    const { model } = await listing(api, "/dir");
    table = new TableModel();
    table.setRows(model.visible);
  });

  describe("pull, not push", () => {
    it("exposes a row count and per-cell access instead of an array of rows", () => {
      expect(table.rowCount).toBe(3);
      expect(table.getCell(0, "name")).toBe("sub");
      expect(table.getCell(1, "name")).toBe("a.txt");
    });

    it("renders a directory's size as an empty VALUE, not as unavailable", () => {
      // "" means "this directory has no size"; undefined means "not loaded".
      // A grid renders the second as a loading cell, so they must not be conflated.
      expect(table.getCell(0, "size")).toBe("");
      expect(table.getCell(0, "date")).toBe("");
      expect(table.getCell(1, "size")).toBe("3");
    });

    it("returns undefined past the end, which a windowed grid reads as 'not loaded'", () => {
      expect(table.getCell(99, "name")).toBeUndefined();
      expect(table.getRowKey(99)).toBeUndefined();
    });
  });

  describe("selection is keyed by path, never by index", () => {
    it("survives a refresh that reorders the listing", async () => {
      table.selected = new Set(["/dir/a.txt"]);
      expect(table.isSelected(1)).toBe(true);

      // A new file sorts ahead of a.txt: an index-keyed selection would now
      // point at the wrong row, silently.
      await api.write("/dir/A-first.txt", [new TextEncoder().encode("n")]);
      const { model } = await listing(api, "/dir");
      table.setRows(model.visible);

      const selectedNames = model.visible
        .map((_, row) => (table.isSelected(row) ? table.getCell(row, "name") : undefined))
        .filter(Boolean);
      expect(selectedNames).toEqual(["a.txt"]);
    });

    it("drops a selected row that no longer exists, without renumbering the rest", async () => {
      table.selected = new Set(["/dir/a.txt", "/dir/b.txt"]);
      await api.remove("/dir/a.txt");
      const { model } = await listing(api, "/dir");
      table.setRows(model.visible);

      expect(table.selectionRanges().length).toBe(1);
      const [range] = table.selectionRanges();
      expect(table.getCell(range.start, "name")).toBe("b.txt");
    });

    it("derives contiguous ranges for grids whose API speaks in ranges", () => {
      table.selected = new Set(["/dir/sub", "/dir/a.txt"]);
      expect(table.selectionRanges()).toEqual([{ start: 0, end: 2 }]);
      table.selected = new Set(["/dir/sub", "/dir/b.txt"]);
      expect(table.selectionRanges()).toEqual([
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ]);
    });
  });

  describe("cursor", () => {
    it("is clamped when the listing shrinks under it", async () => {
      table.cursor = 2;
      await api.remove("/dir/b.txt");
      const { model } = await listing(api, "/dir");
      table.setRows(model.visible);
      expect(table.cursor).toBe(1);
    });

    it("does not move when the listing grows", () => {
      table.cursor = 1;
      table.setRows([...(table as never as { _rows: never[] })._rows]);
      expect(table.cursor).toBe(1);
    });
  });

  it("marks rows by path, mirroring the panel", () => {
    table.marks = { "/dir/a.txt": { jobId: "j9", kind: "pending-delete" } };
    expect(table.markOf(1)).toEqual({ jobId: "j9", kind: "pending-delete" });
    expect(table.markOf(0)).toBeUndefined();
  });

  it("replaces model state rather than mutating it", async () => {
    await expectReplacedNotMutated(
      table,
      () => table.rowCount,
      () => table.setRows([]),
    );
  });
});
