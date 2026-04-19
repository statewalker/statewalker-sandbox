import { describe, expect, it } from "vitest";
import { simplifyTrackSizes } from "../simplify.ts";

describe("simplifyTrackSizes", () => {
  it("should return px units when fractions disabled", () => {
    const result = simplifyTrackSizes([100, 200, 300], 5, false);
    expect(result).toEqual([
      { value: 100, unit: "px" },
      { value: 200, unit: "px" },
      { value: 300, unit: "px" },
    ]);
  });

  it("should discover equal fr tracks", () => {
    const result = simplifyTrackSizes([200, 200, 200], 10, true);
    const frTracks = result.filter((r) => r.unit === "fr");
    expect(frTracks.length).toBe(3);
    for (const t of frTracks) {
      expect(t.value).toBe(1);
    }
  });

  it("should keep single track as px", () => {
    const result = simplifyTrackSizes([400], 5, true);
    expect(result[0].unit).toBe("px");
  });
});
