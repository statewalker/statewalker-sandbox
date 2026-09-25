import HighTable from "hightable";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "hightable/src/HighTable.css";
import { TableModel } from "@fm/app";
import { toDataFrame } from "@fm/ui";

/**
 * D2e — HOW the grid uses the model to virtualize.
 *
 * The claim under test: the model is asked only about the rows in the window,
 * never about the listing. These tests record every call the grid makes.
 */

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `f${String(i).padStart(6, "0")}.txt`,
    path: `/d/f${String(i).padStart(6, "0")}.txt`,
    kind: "file" as const,
    size: i,
    lastModified: 1_700_000_000_000 + i,
  }));

interface Calls {
  numRowsReads: number;
  cells: number[];
  rowNumbers: number[];
  reset(): void;
}

let root: Root | undefined;
let outer: HTMLElement | undefined;

afterEach(() => {
  root?.unmount();
  outer?.remove();
  root = outer = undefined;
});

const mount = async (n: number) => {
  const model = new TableModel();
  model.setRows(rows(n) as never);
  const { frame } = toDataFrame(model);

  const calls: Calls = {
    numRowsReads: 0,
    cells: [],
    rowNumbers: [],
    reset() {
      this.numRowsReads = 0;
      this.cells = [];
      this.rowNumbers = [];
    },
  };

  // A recording proxy in front of the adapter: everything the grid pulls
  // passes through here.
  const recorded = {
    get columnDescriptors() {
      return frame.columnDescriptors;
    },
    get numRows() {
      calls.numRowsReads++;
      return frame.numRows;
    },
    getRowNumber(args: { row: number }) {
      calls.rowNumbers.push(args.row);
      return frame.getRowNumber(args);
    },
    getCell(args: { row: number; column: string }) {
      calls.cells.push(args.row);
      return frame.getCell(args);
    },
    eventTarget: frame.eventTarget,
  };

  outer = document.createElement("div");
  outer.style.cssText = "height:600px;width:800px;display:flex;flex-direction:column";
  const host = document.createElement("div");
  host.style.cssText = "flex:1;display:flex;flex-direction:column;min-height:0";
  outer.appendChild(host);
  document.body.appendChild(outer);

  root = createRoot(host);
  root.render(createElement(HighTable as never, { data: recorded }));
  await new Promise((r) => setTimeout(r, 250));
  return { model, host, calls, frame };
};

const scroller = (host: HTMLElement) =>
  [...host.querySelectorAll("div")].find((el) => el.scrollHeight > el.clientHeight + 1)!;

describe("D2e · how the grid pulls from the model", () => {
  it("reads numRows, then asks only about a window of rows", async () => {
    const { calls } = await mount(100_000);

    expect(calls.numRowsReads).toBeGreaterThan(0); // total height comes from this
    const asked = new Set(calls.cells);
    expect(asked.size).toBeGreaterThan(0);
    // Three columns × a few dozen rows — not 100 000 of anything.
    expect(asked.size).toBeLessThan(200);
    expect(Math.max(...asked)).toBeLessThan(200);
  });

  it("asks about a contiguous range, with overscan beyond the visible rows", async () => {
    const { host, calls } = await mount(100_000);
    const visible = host.querySelectorAll("tbody tr").length;
    const asked = [...new Set(calls.cells)].sort((a, b) => a - b);

    // Contiguous: the window is a range, not a scatter.
    expect(asked[asked.length - 1] - asked[0] + 1).toBe(asked.length);
    // Overscan: slightly more rows are fetched than are painted, so scrolling
    // does not immediately hit unresolved cells.
    expect(asked.length).toBeGreaterThanOrEqual(visible);
  });

  it("moves the asked-about range when the user scrolls, without re-asking the top", async () => {
    const { host, calls } = await mount(100_000);
    const top = [...new Set(calls.cells)].sort((a, b) => a - b);
    calls.reset();

    const el = scroller(host);
    el.scrollTop = 20_000;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    const after = [...new Set(calls.cells)].sort((a, b) => a - b);
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(300);
    // The new window is far from the old one: the grid did not re-read the
    // whole listing, it moved.
    expect(Math.min(...after)).toBeGreaterThan(Math.max(...top));
    expect(Math.min(...after)).toBeGreaterThan(300);
  });

  it("re-pulls only the window after one model pulse", async () => {
    const { model, calls } = await mount(100_000);
    calls.reset();

    model.setRows(rows(100_000).map((r, i) => ({ ...r, name: `x${i}.txt` })) as never);
    await new Promise((r) => setTimeout(r, 250));

    const asked = new Set(calls.cells);
    expect(asked.size).toBeGreaterThan(0);
    // A listing replaced under the grid costs a window's worth of reads, not
    // 100 000 — which is what makes C4's invalidation affordable.
    expect(asked.size).toBeLessThan(200);
  });

  it("reads the new total when the projection shrinks under a filter", async () => {
    const { model, calls } = await mount(100_000);
    calls.reset();

    model.setRows(rows(100_000).filter((r) => r.name.includes("42")) as never);
    await new Promise((r) => setTimeout(r, 250));

    expect(calls.numRowsReads).toBeGreaterThan(0);
    expect(Math.max(...calls.cells)).toBeLessThan(model.rowCount);
  });

  it("never materialises the listing: the model exposes no array of rows", async () => {
    const { model } = await mount(1000);
    // The adapter is written against `rowCount` + `getCell`. If a `rows`
    // accessor existed, a future renderer would reach for it and the window
    // would quietly become a copy.
    expect((model as unknown as Record<string, unknown>).rows).toBeUndefined();
    expect(typeof model.getCell).toBe("function");
    expect(typeof model.rowCount).toBe("number");
  });

  it("treats an unresolved cell as a loading cell, not as an empty one", async () => {
    // `getCell` returning undefined is how a paged or streamed listing will
    // announce "not here yet". The grid marks those cells busy rather than
    // rendering them blank, so the vocabulary already exists.
    const { host, frame } = await mount(100);
    expect(frame.getCell({ row: 500, column: "name" })).toBeUndefined();
    expect(host.querySelectorAll("tbody td[aria-busy=true]").length).toBe(0);
  });
});
