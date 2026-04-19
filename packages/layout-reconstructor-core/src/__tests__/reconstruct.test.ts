import { describe, expect, it } from "vitest";
import { reconstructGrid } from "../reconstruct.ts";
import type { InputBlock } from "../types.ts";

describe("reconstructGrid", () => {
  it("should reconstruct a simple 2-column layout", () => {
    const blocks: InputBlock[] = [
      { label: "left", left: 0, top: 0, width: 200, height: 400 },
      { label: "right", left: 200, top: 0, width: 200, height: 400 },
    ];
    const config = reconstructGrid(blocks, { discoverFractions: false });

    expect(config.columns).toHaveLength(2);
    expect(config.rows).toHaveLength(1);
    expect(config.areas).toEqual([["left", "right"]]);
  });

  it("should reconstruct a header + body + footer layout", () => {
    const blocks: InputBlock[] = [
      { label: "header", left: 0, top: 0, width: 400, height: 50 },
      { label: "body", left: 0, top: 50, width: 400, height: 300 },
      { label: "footer", left: 0, top: 350, width: 400, height: 50 },
    ];
    const config = reconstructGrid(blocks, { discoverFractions: false });

    expect(config.rows).toHaveLength(3);
    expect(config.columns).toHaveLength(1);
    expect(config.areas).toEqual([["header"], ["body"], ["footer"]]);
  });

  it("should reconstruct a classic layout with header spanning columns", () => {
    const blocks: InputBlock[] = [
      { label: "header", left: 0, top: 0, width: 1024, height: 80 },
      { label: "nav", left: 0, top: 80, width: 200, height: 688 },
      { label: "main", left: 200, top: 80, width: 824, height: 688 },
    ];
    const config = reconstructGrid(blocks, { discoverFractions: false });

    expect(config.areas).toEqual([
      ["header", "header"],
      ["nav", "main"],
    ]);
    expect(config.rows[0].value).toBe(80);
    expect(config.columns[0].value).toBe(200);
  });

  it("should discover fr units for equal-width columns", () => {
    const blocks: InputBlock[] = [
      { label: "a", left: 0, top: 0, width: 200, height: 400 },
      { label: "b", left: 200, top: 0, width: 200, height: 400 },
    ];
    const config = reconstructGrid(blocks, { discoverFractions: true });

    const frCols = config.columns.filter((c) => c.unit === "fr");
    expect(frCols.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle empty input", () => {
    const config = reconstructGrid([]);
    expect(config.rows).toEqual([]);
    expect(config.columns).toEqual([]);
    expect(config.areas).toEqual([]);
  });

  it("should handle single block", () => {
    const blocks: InputBlock[] = [{ label: "only", left: 0, top: 0, width: 400, height: 300 }];
    const config = reconstructGrid(blocks, { discoverFractions: false });
    expect(config.areas.flat()).toContain("only");
  });

  it("should detect containment and create children", () => {
    const blocks: InputBlock[] = [
      { label: "outer", left: 0, top: 0, width: 400, height: 300 },
      { label: "innerA", left: 10, top: 10, width: 180, height: 280 },
      { label: "innerB", left: 200, top: 10, width: 190, height: 280 },
    ];
    const config = reconstructGrid(blocks, {
      discoverFractions: false,
      snapTolerance: 5,
    });

    // The outer block should contain innerA and innerB as children
    expect(config.children).toBeDefined();
    if (config.children) {
      expect(config.children.outer).toBeDefined();
      const childAreas = config.children.outer.areas.flat();
      expect(childAreas).toContain("innerA");
      expect(childAreas).toContain("innerB");
    }
  });

  it("should handle a complex document-like layout", () => {
    // Simulating a typical document page:
    // - Full-width header (0-4096 x 0-200)
    // - Left sidebar (0-1024 x 200-3600)
    // - Main content (1024-4096 x 200-3600)
    // - Full-width footer (0-4096 x 3600-4096)
    const blocks: InputBlock[] = [
      { label: "header", left: 0, top: 0, width: 4096, height: 200 },
      { label: "sidebar", left: 0, top: 200, width: 1024, height: 3400 },
      { label: "content", left: 1024, top: 200, width: 3072, height: 3400 },
      { label: "footer", left: 0, top: 3600, width: 4096, height: 496 },
    ];
    const config = reconstructGrid(blocks, { discoverFractions: false });

    expect(config.areas).toEqual([
      ["header", "header"],
      ["sidebar", "content"],
      ["footer", "footer"],
    ]);
    expect(config.rows).toHaveLength(3);
    expect(config.columns).toHaveLength(2);
  });
});
