import { describe, expect, it } from "vitest";
import { buildTopologyByEdgeProjection, suggestColumnCounts } from "../topology.ts";
import type { InputBlock } from "../types.ts";

describe("buildTopologyByEdgeProjection", () => {
  it("should create a 2-column layout from side-by-side blocks", () => {
    const blocks: InputBlock[] = [
      { label: "left", left: 0, top: 0, width: 200, height: 400 },
      { label: "right", left: 200, top: 0, width: 200, height: 400 },
    ];
    const topo = buildTopologyByEdgeProjection(blocks, 400, 400);

    expect(topo.colLines).toEqual([0, 200, 400]);
    expect(topo.rowLines).toEqual([0, 400]);
    expect(topo.spans).toHaveLength(2);
    expect(topo.spans[0]).toEqual({
      label: "left",
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 0,
    });
    expect(topo.spans[1]).toEqual({
      label: "right",
      rowStart: 0,
      rowEnd: 0,
      colStart: 1,
      colEnd: 1,
    });
  });

  it("should create a 2-row layout from stacked blocks", () => {
    const blocks: InputBlock[] = [
      { label: "top", left: 0, top: 0, width: 400, height: 100 },
      { label: "bottom", left: 0, top: 100, width: 400, height: 300 },
    ];
    const topo = buildTopologyByEdgeProjection(blocks, 400, 400);

    expect(topo.rowLines).toEqual([0, 100, 400]);
    expect(topo.colLines).toEqual([0, 400]);
    expect(topo.spans[0]).toEqual({
      label: "top",
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 0,
    });
  });

  it("should handle spanning blocks (header + 2-column body)", () => {
    const blocks: InputBlock[] = [
      { label: "header", left: 0, top: 0, width: 400, height: 50 },
      { label: "nav", left: 0, top: 50, width: 100, height: 350 },
      { label: "main", left: 100, top: 50, width: 300, height: 350 },
    ];
    const topo = buildTopologyByEdgeProjection(blocks, 400, 400);

    expect(topo.colLines).toEqual([0, 100, 400]);
    expect(topo.rowLines).toEqual([0, 50, 400]);

    // header spans both columns
    const header = topo.spans.find((s) => s.label === "header");
    expect(header).toEqual({
      label: "header",
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 1,
    });
  });
});

describe("suggestColumnCounts", () => {
  it("should suggest 2 columns for equal-width side-by-side blocks", () => {
    const blocks: InputBlock[] = [
      { label: "a", left: 0, top: 0, width: 200, height: 100 },
      { label: "b", left: 200, top: 0, width: 200, height: 100 },
    ];
    const counts = suggestColumnCounts(blocks, 400, 10);
    expect(counts).toContain(2);
  });

  it("should suggest 1 column for full-width blocks", () => {
    const blocks: InputBlock[] = [
      { label: "a", left: 0, top: 0, width: 400, height: 100 },
      { label: "b", left: 0, top: 100, width: 400, height: 100 },
    ];
    const counts = suggestColumnCounts(blocks, 400, 10);
    expect(counts).toContain(1);
  });
});
