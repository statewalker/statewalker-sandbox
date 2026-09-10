import { describe, expect, it } from "vitest";
import { TableModel } from "@fm/app";
import { toDataFrame, orderByFor } from "@fm/ui";

/** D2a — the grid adapter is a projection over the model, holding no state. */

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `f${i}.txt`,
    path: `/dir/f${i}.txt`,
    kind: "file" as const,
    size: i,
    lastModified: 1_700_000_000_000 + i,
  }));

const build = (n = 3) => {
  const model = new TableModel();
  model.setRows(rows(n) as never);
  return { model, ...toDataFrame(model) };
};

describe("D2a · DataFrame adapter", () => {
  it("publishes the model's columns, with sortability", () => {
    const { frame } = build();
    expect(frame.columnDescriptors).toEqual([
      { name: "name", sortable: true },
      { name: "size", sortable: true },
      { name: "date", sortable: true },
    ]);
  });

  it("reads the row count live, rather than snapshotting it", () => {
    const { model, frame } = build(3);
    expect(frame.numRows).toBe(3);
    model.setRows(rows(10) as never);
    expect(frame.numRows).toBe(10); // no re-adaptation needed
  });

  it("turns one model pulse into one update event", () => {
    const { model, frame } = build();
    let updates = 0;
    frame.eventTarget.addEventListener("update", () => updates++);
    model.setRows(rows(5) as never);
    model.setRows(rows(6) as never);
    expect(updates).toBe(2);
  });

  it("stops listening when disposed", () => {
    const { model, frame, dispose } = build();
    let updates = 0;
    frame.eventTarget.addEventListener("update", () => updates++);
    dispose();
    model.setRows(rows(5) as never);
    expect(updates).toBe(0);
  });

  it("wraps a present value and leaves an absent one undefined", () => {
    const { frame } = build(2);
    expect(frame.getCell({ row: 0, column: "name" })).toEqual({ value: "f0.txt" });
    expect(frame.getCell({ row: 0, column: "size" })).toEqual({ value: "0" });
    expect(frame.getCell({ row: 99, column: "name" })).toBeUndefined();
    expect(frame.getRowNumber({ row: 1 })).toEqual({ value: 1 });
    expect(frame.getRowNumber({ row: 99 })).toBeUndefined();
  });

  it("keeps sorting with the controller, not the grid", () => {
    const { model } = build();
    expect(orderByFor(model)).toEqual([{ column: "name", direction: "ascending" }]);
    model.sortDirection = "descending";
    // Descending is expressed by the controller's own projection, because the
    // grid's orderBy vocabulary only has "ascending". Two orderings that can
    // disagree is the failure this avoids.
    expect(orderByFor(model)).toEqual([]);
  });
});
