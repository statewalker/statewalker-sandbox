import HighTable from "hightable";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "hightable/src/HighTable.css";
import { TableModel } from "@fm/app";
import { toDataFrame } from "@fm/ui";

/**
 * D2d — does the flex host still work when its own height is INHERITED?
 *
 * D2c proved the flex host with an explicit `height: 600px`. A real panel does
 * not have a fixed height: it fills a slot, inside a layout that fills the
 * viewport. If the constraint only works with a hard-coded pixel value, it is
 * not a solution — it is the same problem one level up.
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
let outer: HTMLElement | undefined;

afterEach(() => {
  root?.unmount();
  outer?.remove();
  root = outer = undefined;
});

/** Builds a layout chain and mounts the grid in the innermost host. */
const mountIn = async (chain: string[], hostStyle: string, n = 100_000) => {
  outer = document.createElement("div");
  let node = outer;
  outer.style.cssText = chain[0];
  for (const style of chain.slice(1)) {
    const child = document.createElement("div");
    child.style.cssText = style;
    node.appendChild(child);
    node = child;
  }
  const host = document.createElement("div");
  host.style.cssText = hostStyle;
  node.appendChild(host);
  document.body.appendChild(outer);

  const model = new TableModel();
  model.setRows(rows(n) as never);
  const { frame } = toDataFrame(model);
  root = createRoot(host);
  root.render(createElement(HighTable as never, { data: frame }));
  await new Promise((r) => setTimeout(r, 250));

  return {
    host,
    mounted: !!host.firstElementChild,
    rendered: host.querySelectorAll("tbody tr").length,
    gridHeight: (host.firstElementChild as HTMLElement | null)?.clientHeight ?? 0,
    hostHeight: host.clientHeight,
  };
};

const HOST = "display:flex;flex-direction:column;min-height:0";

describe("D2d · the flex chain, with no fixed pixel height anywhere", () => {
  it("works when the height comes from a viewport-sized ancestor", async () => {
    const result = await mountIn(
      [
        "height:100vh;width:900px;display:flex;flex-direction:column", // app shell
        "flex:1;min-height:0;display:flex", // panel row
      ],
      `flex:1;${HOST}`, // the panel's slot
    );
    expect(result.mounted).toBe(true);
    expect(result.rendered).toBeGreaterThan(0);
    expect(result.rendered).toBeLessThan(200);
    expect(result.gridHeight).toBeLessThanOrEqual(result.hostHeight);
    expect(result.hostHeight).toBeGreaterThan(100);
  });

  it("still windows with a toolbar and a status bar above and below it", async () => {
    outer = document.createElement("div");
    outer.style.cssText = "height:100vh;width:900px;display:flex;flex-direction:column";
    const toolbar = document.createElement("div");
    toolbar.style.cssText = "height:40px;flex:none";
    const status = document.createElement("div");
    status.style.cssText = "height:24px;flex:none";
    const host = document.createElement("div");
    host.style.cssText = `flex:1;${HOST}`;
    outer.append(toolbar, host, status);
    document.body.appendChild(outer);

    const model = new TableModel();
    model.setRows(rows(100_000) as never);
    const { frame } = toDataFrame(model);
    root = createRoot(host);
    root.render(createElement(HighTable as never, { data: frame }));
    await new Promise((r) => setTimeout(r, 250));

    expect(host.querySelectorAll("tbody tr").length).toBeLessThan(200);
    expect(host.clientHeight).toBeLessThan(outer.clientHeight);
    expect(host.clientHeight).toBeGreaterThan(0);
  });

  it("FAILS without min-height:0 on the chain — the flex-item default is auto", async () => {
    // The trap: a flex item's min-height defaults to `auto`, so it refuses to
    // shrink below its content. One missing `min-height: 0` anywhere in the
    // chain and the height is unbounded again, exactly as with a block host.
    const result = await mountIn(
      [
        "height:100vh;width:900px;display:flex;flex-direction:column",
        "flex:1;display:flex", // <- min-height:0 deliberately omitted
      ],
      "flex:1;display:flex;flex-direction:column",
    );
    expect(result.mounted).toBe(false); // the guard refused to render at 100k
  });

  it("that same broken chain looks fine at 500 rows", async () => {
    const result = await mountIn(
      ["height:100vh;width:900px;display:flex;flex-direction:column", "flex:1;display:flex"],
      "flex:1;display:flex;flex-direction:column",
      500,
    );
    // Which is why the 100k case has to be part of the suite: the missing
    // min-height is invisible on any listing small enough to fit. The host
    // itself grows past the viewport here — every row is in the DOM and the
    // page scrolls instead of the table.
    expect(result.mounted).toBe(true);
    expect(result.hostHeight).toBeGreaterThan(window.innerHeight);
    expect(result.host.querySelectorAll("tbody tr").length).toBe(500);
  });

  it("resizes with the viewport, with no code running", async () => {
    const result = await mountIn(
      ["height:600px;width:900px;display:flex;flex-direction:column"],
      `flex:1;${HOST}`,
    );
    const before = result.host.clientHeight;
    outer!.style.height = "300px";
    await new Promise((r) => setTimeout(r, 250));

    expect(result.host.clientHeight).toBeLessThan(before);
    expect(result.host.querySelectorAll("tbody tr").length).toBeLessThan(200);
    expect(result.host.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
  });
});
