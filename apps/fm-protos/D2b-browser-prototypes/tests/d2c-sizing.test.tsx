import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import HighTable from "hightable";
import "hightable/src/HighTable.css";
import { TableModel } from "@fm/app";
import { toDataFrame } from "@fm/ui";

/**
 * D2c — how should the host bound the grid's height?
 *
 * Three candidates, measured rather than argued:
 *   A. a stylesheet rule with `!important` on the host's children
 *   B. imperative `style.height = "100%"` on the grid's root node
 *   C. the host as a FLEX COLUMN, which is what the library's own root rule
 *      (`display:flex; flex:1; min-height:0`) is written for
 */

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `f${String(i).padStart(6, "0")}.txt`,
    path: `/d/f${String(i).padStart(6, "0")}.txt`,
    kind: "file" as const,
    size: i,
    lastModified: 1_700_000_000_000 + i,
  }));

let root: Root | undefined;
let host: HTMLElement | undefined;
let sheet: HTMLStyleElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  sheet?.remove();
  root = host = sheet = undefined;
});

const render = async (model: TableModel, strategy: "important" | "imperative" | "flex") => {
  host = document.createElement("div");
  host.style.width = "800px";
  host.style.height = "600px";
  if (strategy === "flex") {
    host.style.display = "flex";
    host.style.flexDirection = "column";
  } else {
    host.style.overflow = "hidden";
  }
  if (strategy === "important") {
    sheet = document.createElement("style");
    sheet.textContent = ".probe > * { height: 100% !important; max-height: 100% !important; }";
    document.head.appendChild(sheet);
    host.className = "probe";
  }
  document.body.appendChild(host);

  const { frame } = toDataFrame(model);
  root = createRoot(host);
  root.render(createElement(HighTable as never, { data: frame }));
  await new Promise((r) => setTimeout(r, 250));

  if (strategy === "imperative" && host.firstElementChild) {
    (host.firstElementChild as HTMLElement).style.height = "100%";
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    mounted: !!host.firstElementChild,
    rows: host.querySelectorAll("tbody tr").length,
    rootHeight: (host.firstElementChild as HTMLElement | null)?.clientHeight ?? 0,
  };
};

describe("D2c · bounding the grid's height", () => {
  it("A — a stylesheet rule with !important windows correctly", async () => {
    const model = new TableModel();
    model.setRows(rows(100_000) as never);
    const { rows: rendered, rootHeight } = await render(model, "important");
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
    expect(rootHeight).toBeLessThanOrEqual(600);
  });

  it("B — imperative height arrives TOO LATE at 100k: there is no node to style", async () => {
    const model = new TableModel();
    model.setRows(rows(100_000) as never);
    const { mounted, rows: rendered } = await render(model, "imperative");
    // The grid computes its window during its FIRST render. Unbounded, it
    // refuses ("attempted to render too many rows") and React commits nothing,
    // so `firstElementChild` is null and there is nothing left to fix up.
    // A post-mount style write cannot solve a problem that happens pre-mount.
    expect(mounted).toBe(false);
    expect(rendered).toBe(0);
  });

  it("B does work at small row counts — which is exactly what makes it dangerous", async () => {
    const model = new TableModel();
    model.setRows(rows(500) as never);
    const { mounted, rootHeight } = await render(model, "imperative");
    // Under the guard's threshold the grid renders every row, the imperative
    // write then bounds the box, and it LOOKS correct. The failure only shows
    // up on a large directory, in front of a user.
    expect(mounted).toBe(true);
    expect(rootHeight).toBeLessThanOrEqual(600);
  });

  it("C — a flex host needs no override at all", async () => {
    const model = new TableModel();
    model.setRows(rows(100_000) as never);
    const { rows: rendered, rootHeight } = await render(model, "flex");
    // The library's root already declares `flex: 1; min-height: 0`. Given a
    // flex parent with a definite height, it fills and clips by itself: no
    // !important, no imperative write, nothing to keep in sync.
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
    expect(rootHeight).toBeLessThanOrEqual(600);
  });

  it("B does NOT survive a remount — the write has to be redone every time", async () => {
    const model = new TableModel();
    model.setRows(rows(500) as never);
    await render(model, "imperative");
    expect((host!.firstElementChild as HTMLElement).style.height).toBe("100%");

    // The view is torn down and re-created, as it is whenever `ui:show-panel`
    // settles and is re-issued.
    root!.unmount();
    root = createRoot(host!);
    const { frame } = toDataFrame(model);
    root.render(createElement(HighTable as never, { data: frame }));
    await new Promise((r) => setTimeout(r, 250));

    expect((host!.firstElementChild as HTMLElement).style.height).toBe("");
    expect((host!.firstElementChild as HTMLElement).clientHeight).toBeGreaterThan(600);
  });

  it("C survives a remount, because the constraint lives on the host", async () => {
    const model = new TableModel();
    model.setRows(rows(100_000) as never);
    await render(model, "flex");

    root!.unmount();
    root = createRoot(host!);
    const { frame } = toDataFrame(model);
    root.render(createElement(HighTable as never, { data: frame }));
    await new Promise((r) => setTimeout(r, 250));

    expect((host!.firstElementChild as HTMLElement).clientHeight).toBeLessThanOrEqual(600);
    expect(host!.querySelectorAll("tbody tr").length).toBeLessThan(200);
  });

  it("C follows a resized host without any code running", async () => {
    const model = new TableModel();
    model.setRows(rows(100_000) as never);
    await render(model, "flex");
    const before = (host!.firstElementChild as HTMLElement).clientHeight;

    host!.style.height = "300px";
    await new Promise((r) => setTimeout(r, 250));
    const after = (host!.firstElementChild as HTMLElement).clientHeight;

    expect(before).toBeGreaterThan(after);
    expect(after).toBeLessThanOrEqual(300);
  });
});
