import { describe, expect, it } from "vitest";
import { buildAreasMatrix, computeTrackSizes } from "../grid-builder.ts";
import type { GridTopology } from "../types.ts";

describe("buildAreasMatrix", () => {
  it("should build a simple 2-column matrix", () => {
    const topology: GridTopology = {
      rowLines: [0, 400],
      colLines: [0, 200, 400],
      spans: [
        { label: "left", rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        { label: "right", rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 },
      ],
    };
    const matrix = buildAreasMatrix(topology);
    expect(matrix).toEqual([["left", "right"]]);
  });

  it("should build a header + 2-column body matrix", () => {
    const topology: GridTopology = {
      rowLines: [0, 50, 400],
      colLines: [0, 100, 400],
      spans: [
        { label: "header", rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
        { label: "nav", rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
        { label: "main", rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
      ],
    };
    const matrix = buildAreasMatrix(topology);
    expect(matrix).toEqual([
      ["header", "header"],
      ["nav", "main"],
    ]);
  });

  it("should fill empty cells with '.'", () => {
    const topology: GridTopology = {
      rowLines: [0, 100, 200],
      colLines: [0, 100, 200],
      spans: [
        { label: "a", rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        { label: "b", rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
      ],
    };
    const matrix = buildAreasMatrix(topology);
    expect(matrix).toEqual([
      ["a", "."],
      [".", "b"],
    ]);
  });

  it("should return null for overlapping blocks", () => {
    const topology: GridTopology = {
      rowLines: [0, 200],
      colLines: [0, 200],
      spans: [
        { label: "a", rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        { label: "b", rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      ],
    };
    const matrix = buildAreasMatrix(topology);
    expect(matrix).toBeNull();
  });

  it("should handle multi-row spanning", () => {
    const topology: GridTopology = {
      rowLines: [0, 100, 200, 300],
      colLines: [0, 150, 400],
      spans: [
        { label: "head", rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
        { label: "nav", rowStart: 1, rowEnd: 2, colStart: 0, colEnd: 0 },
        { label: "main", rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
        { label: "foot", rowStart: 2, rowEnd: 2, colStart: 1, colEnd: 1 },
      ],
    };
    const matrix = buildAreasMatrix(topology);
    expect(matrix).toEqual([
      ["head", "head"],
      ["nav", "main"],
      ["nav", "foot"],
    ]);
  });
});

describe("computeTrackSizes", () => {
  it("should compute sizes from grid lines", () => {
    expect(computeTrackSizes([0, 100, 300, 400])).toEqual([100, 200, 100]);
  });

  it("should handle single track", () => {
    expect(computeTrackSizes([0, 400])).toEqual([400]);
  });
});
