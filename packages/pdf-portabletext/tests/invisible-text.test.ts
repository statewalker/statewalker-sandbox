import { describe, expect, it } from "vitest";
import { isInvisibleRun } from "../src/pdf-extract.ts";
import { runsToImageWords } from "../src/text-layer-ocr.ts";

describe("invisible text", () => {
  const visibility = { visible: "Title2024", invisible: "Scannedwordshere2024" };

  it("classifies runs by where their text was drawn", () => {
    expect(isInvisibleRun("Scanned words", visibility)).toBe(true);
    expect(isInvisibleRun("Title", visibility)).toBe(false);
    // Text drawn both ways counts as visible.
    expect(isInvisibleRun("2024", visibility)).toBe(false);
    expect(isInvisibleRun("anything", { visible: "x", invisible: "" })).toBe(false);
  });

  it("maps an invisible layer into image pixels, word by word", () => {
    // Image drawn at (100,200) as 200×100 pt, stored as 400×200 px (2 px per pt).
    const image = {
      bbox: { x: 100, y: 200, width: 200, height: 100, unit: "pt" as const },
      width: 400,
      height: 200,
    };
    const run = (str: string, x: number, y: number) => ({
      str,
      x,
      y,
      width: str.length * 5,
      fontSize: 10,
      hasEOL: false,
      invisible: true,
    });
    const words = runsToImageWords(
      [run("Hello world", 110, 230), run("second", 110, 250), run("outside", 10, 10)],
      image,
    );
    expect(words.map((w) => w.text)).toEqual(["Hello", "world", "second"]);
    expect(words[0].rect).toEqual({ left: 20, right: 70, top: 44, bottom: 64 });
    expect(words[1].rect.left).toBe(80); // "world" starts at character 6
    expect(words.map((w) => [w.startOfLine, w.endOfLine])).toEqual([
      [true, false],
      [false, true],
      [true, true],
    ]);
  });
});
