import HighTable from "hightable";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "hightable/src/HighTable.css";
import { TableModel } from "@fm/app";
import { toDataFrame } from "@fm/ui";

/**
 * D2b — the one rung whose failure mode is "it works but feels bad".
 *
 * These assertions are about the WINDOW: how much of a 100k-row listing
 * actually reaches the DOM, and whether a model pulse is enough to move it.
 */

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `file-${String(i).padStart(6, "0")}.txt`,
    path: `/dir/file-${String(i).padStart(6, "0")}.txt`,
    kind: "file" as const,
    size: i,
    lastModified: 1_700_000_000_000 + i,
  }));

let root: Root | undefined;
let host: HTMLElement | undefined;

/**
 * The host is a FLEX COLUMN with a definite height. Nothing else.
 *
 * The grid's own root rule is `display:flex; flex:1; min-height:0` — it is
 * written to be a flex child and fills and clips by itself once given a flex
 * parent with a definite height. No `!important`, no imperative write, nothing
 * to re-apply on remount or on resize. See d2c-sizing.test.tsx for the
 * comparison that settled this.
 */
const mount = async (model: TableModel) => {
  host = document.createElement("div");
  host.style.cssText = "height:600px;width:800px;display:flex;flex-direction:column";
  document.body.appendChild(host);
  const { frame } = toDataFrame(model);
  root = createRoot(host);
  root.render(createElement(HighTable as never, { data: frame, cacheKey: "d2b" }));
  await new Promise((r) => setTimeout(r, 200));
  return host;
};

const cellTexts = () =>
  [...(host?.querySelectorAll("tbody td") ?? [])].map((td) => td.textContent ?? "");

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("D2b · a model-driven grid at scale", () => {
  it("renders a window, not a listing: 100k rows reach the DOM as a few dozen", async () => {
    const model = new TableModel();
    model.setRows(rows(100_000) as never);
    await mount(model);

    const renderedRows = host!.querySelectorAll("tbody tr").length;
    expect(renderedRows).toBeGreaterThan(0);
    expect(host!.firstElementChild!.clientHeight).toBeLessThanOrEqual(600);
    // The whole point of virtualization: the DOM cost is bounded by the
    // viewport, not by the directory.
    expect(renderedRows).toBeLessThan(200);
    expect(cellTexts().some((t) => t.includes("file-000000"))).toBe(true);
  });

  it("builds the model for 100k entries well inside a keystroke", () => {
    const data = rows(100_000);
    const model = new TableModel();
    const started = performance.now();
    model.setRows(data as never);
    const elapsed = performance.now() - started;
    expect(model.rowCount).toBe(100_000);
    expect(elapsed).toBeLessThan(50);
  });

  it("reads cells at the far end as cheaply as at the near end", () => {
    const model = new TableModel();
    model.setRows(rows(100_000) as never);
    const { frame } = toDataFrame(model);

    const time = (row: number) => {
      const started = performance.now();
      for (let i = 0; i < 1000; i++) frame.getCell({ row: row + (i % 50), column: "name" });
      return performance.now() - started;
    };
    const near = time(0);
    const far = time(99_000);
    // Pull-based access must be O(1) in the row index, or scrolling to the
    // bottom of a large directory degrades.
    expect(far).toBeLessThan(Math.max(near * 4, 20));
  });

  it("moves the window when the model is scrolled", async () => {
    const model = new TableModel();
    model.setRows(rows(100_000) as never);
    await mount(model);
    const before = cellTexts();

    const scroller = [...host!.querySelectorAll("div")].find(
      (el) => el.scrollHeight > el.clientHeight + 1,
    )!;
    scroller.scrollTop = 20_000;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));

    const after = cellTexts();
    expect(after).not.toEqual(before);
    expect(after.some((t) => /file-000\d\d\d/.test(t))).toBe(true);
  });

  it("re-renders from one model pulse, with no prop change", async () => {
    const model = new TableModel();
    model.setRows(rows(100) as never);
    await mount(model);
    expect(cellTexts().some((t) => t.includes("file-000000"))).toBe(true);

    // The controller replaced the listing; the view was told nothing.
    model.setRows(rows(100).map((r, i) => ({ ...r, name: `renamed-${i}.txt` })) as never);
    await new Promise((r) => setTimeout(r, 200));

    expect(cellTexts().some((t) => t.includes("renamed-0"))).toBe(true);
  });

  it("shrinks the row count live when a filter narrows the projection", async () => {
    const model = new TableModel();
    const all = rows(1000);
    model.setRows(all as never);
    await mount(model);

    const started = performance.now();
    model.setRows(all.filter((r) => r.name.includes("42")) as never);
    const elapsed = performance.now() - started;
    await new Promise((r) => setTimeout(r, 200));

    expect(model.rowCount).toBeLessThan(1000);
    expect(elapsed).toBeLessThan(20); // a filter is a projection, never I/O
    expect(cellTexts().every((t) => t === "" || !/file-000000\.txt/.test(t))).toBe(true);
  });
});
