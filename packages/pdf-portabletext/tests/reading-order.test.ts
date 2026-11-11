import { describe, expect, it } from "vitest";
import { type OrderBox, readingOrder } from "../src/reading-order.ts";

const box = (x: number, y: number, width: number, height: number): OrderBox => ({
  x,
  y,
  width,
  height,
});

describe("readingOrder", () => {
  it("reads a single column top to bottom", () => {
    expect(
      readingOrder([box(50, 200, 400, 30), box(50, 100, 400, 30), box(50, 150, 400, 30)]),
    ).toEqual([1, 2, 0]);
  });

  it("reads columns one after the other, even when paragraph breaks line up", () => {
    const boxes = [
      box(50, 40, 500, 20), // 0 title
      box(50, 100, 230, 60), // 1 left, row 1
      box(310, 100, 230, 60), // 2 right, row 1
      box(50, 180, 230, 60), // 3 left, row 2
      box(310, 180, 230, 60), // 4 right, row 2
      box(50, 260, 230, 40), // 5 left tail (right column is shorter)
      box(50, 340, 500, 20), // 6 footer
    ];
    expect(readingOrder(boxes)).toEqual([0, 1, 3, 5, 2, 4, 6]);
  });

  it("keeps a full-width figure between two column sections", () => {
    const boxes = [
      box(50, 100, 230, 60), // 0
      box(310, 100, 230, 60), // 1
      box(50, 200, 490, 100), // 2 figure
      box(50, 320, 230, 60), // 3
      box(310, 320, 230, 60), // 4
    ];
    expect(readingOrder(boxes)).toEqual([0, 1, 2, 3, 4]);
  });

  it("does not split at gaps narrower than a gutter", () => {
    // Two boxes on one row 3 pt apart (e.g. words of a heading) read left to right.
    expect(readingOrder([box(103, 50, 50, 10), box(50, 50, 50, 10)])).toEqual([1, 0]);
  });
});
