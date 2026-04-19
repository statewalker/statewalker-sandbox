import { describe, expect, it } from "vitest";
import { detectProportionalTracks, solveTrackSizes } from "../constraint-solver.ts";
import type { GridTopology } from "../types.ts";

describe("solveTrackSizes", () => {
  it("should solve a simple 2-column topology", () => {
    const topology: GridTopology = {
      rowLines: [0, 400],
      colLines: [0, 200, 400],
      spans: [
        { label: "left", rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        { label: "right", rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 },
      ],
    };
    const result = solveTrackSizes(topology);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.trackWidths).toHaveLength(2);
      expect(result.trackWidths[0]).toBeCloseTo(200);
      expect(result.trackWidths[1]).toBeCloseTo(200);
      expect(result.trackHeights[0]).toBeCloseTo(400);
    }
  });

  it("should solve a spanning layout", () => {
    const topology: GridTopology = {
      rowLines: [0, 50, 400],
      colLines: [0, 100, 400],
      spans: [
        { label: "header", rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
        { label: "nav", rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
        { label: "main", rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 },
      ],
    };
    const result = solveTrackSizes(topology);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.trackWidths[0]).toBeCloseTo(100);
      expect(result.trackWidths[1]).toBeCloseTo(300);
      expect(result.trackHeights[0]).toBeCloseTo(50);
      expect(result.trackHeights[1]).toBeCloseTo(350);
    }
  });

  it("should return null for empty topology", () => {
    const result = solveTrackSizes({
      rowLines: [0],
      colLines: [0],
      spans: [],
    });
    expect(result).toBeNull();
  });
});

describe("detectProportionalTracks", () => {
  it("should detect equal tracks", () => {
    const { groups, ratios } = detectProportionalTracks([200, 200, 200], 5);
    expect(groups).toHaveLength(1);
    expect(ratios[0]).toBe(1);
  });

  it("should detect 1:2 ratio", () => {
    const { ratios } = detectProportionalTracks([100, 200], 5);
    expect(ratios).toContain(1);
    expect(ratios).toContain(2);
  });

  it("should handle single track", () => {
    const { groups } = detectProportionalTracks([300], 5);
    expect(groups).toHaveLength(1);
  });

  it("should handle zero-size tracks", () => {
    const { groups, ratios } = detectProportionalTracks([0, 200, 200], 5);
    const zeroGroup = groups.find((_, i) => ratios[i] === 0);
    expect(zeroGroup).toBeDefined();
  });
});
