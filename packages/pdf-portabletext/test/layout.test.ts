import { describe, expect, it } from "vitest";
import { createKeyGen } from "../src/keys.ts";
import { groupOcrWords, type OcrWord, ocrWordsToBlocks } from "../src/ocr-layout.ts";
import { bodyFontSize, groupTextRuns, headingStyle } from "../src/text-layout.ts";

const word = (
  text: string,
  left: number,
  top: number,
  flags: { sol?: boolean; eol?: boolean } = {},
): OcrWord => ({
  text,
  confidence: 0.9,
  rect: { left, top, right: left + text.length * 10, bottom: top + 20 },
  startOfLine: !!flags.sol,
  endOfLine: !!flags.eol,
});

describe("OCR layout", () => {
  const words = [
    word("Hallo", 10, 10, { sol: true }),
    word("Welt", 70, 10, { eol: true }),
    word("zweite", 10, 35, { sol: true }),
    word("Zeile", 80, 35, { eol: true }),
    // big vertical gap: new paragraph
    word("Absatz", 10, 120, { sol: true, eol: true }),
  ];

  it("groups words into lines and paragraphs", () => {
    const paragraphs = groupOcrWords(words);
    expect(paragraphs.map((p) => p.map((l) => l.map((w) => w.text).join(" ")))).toEqual([
      ["Hallo Welt", "zweite Zeile"],
      ["Absatz"],
    ]);
  });

  it("emits one span per word with an ocrBox mark pointing at the image bbox", () => {
    const asset = { _type: "reference" as const, _ref: "image-abc-200x200-png" };
    const blocks = ocrWordsToBlocks(words, {
      keyGen: createKeyGen("p1-"),
      page: 1,
      imageKey: "p1-img0",
      asset,
    });
    expect(blocks).toHaveLength(2);
    const [first] = blocks;
    expect(first.children.map((c) => c.text).join("")).toBe("Hallo Welt zweite Zeile");
    expect(first.children).toHaveLength(4);
    const mark = first.markDefs.find((m) => m._key === first.children[1].marks[0]);
    expect(mark).toMatchObject({
      _type: "ocrBox",
      image: "p1-img0",
      asset,
      bbox: { x: 70, y: 10, width: 40, height: 20, unit: "px" },
    });
    expect(first.source).toMatchObject({
      type: "ocr",
      image: "p1-img0",
      bbox: { x: 10, y: 10, width: 120, height: 45, unit: "px" },
    });
    // keys are unique across the document
    const keys = blocks.flatMap((b) => [
      b._key,
      ...b.children.map((c) => c._key),
      ...b.markDefs.map((m) => m._key),
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("drops low-confidence and empty words", () => {
    const noisy = [
      { ...word("~", 0, 0, { sol: true }), confidence: 0.1 },
      word(" ", 20, 0, { eol: true }),
    ];
    expect(
      ocrWordsToBlocks(noisy, {
        keyGen: createKeyGen(),
        page: 1,
        imageKey: "i",
        asset: { _type: "reference", _ref: "x" },
        minConfidence: 0.3,
      }),
    ).toEqual([]);
  });
});

describe("PDF text layout", () => {
  const run = (str: string, x: number, y: number, fontSize = 10, hasEOL = false) => ({
    str,
    x,
    y,
    width: str.length * fontSize * 0.5,
    fontSize,
    hasEOL,
  });

  it("joins runs into lines and lines into paragraphs, de-hyphenating", () => {
    const paragraphs = groupTextRuns([
      run("Title", 50, 40, 24, true),
      run("This is a para-", 50, 80, 10, true),
      run("graph that", 50, 92, 10, false),
      run("continues.", 106, 92, 10, true),
      run("Second paragraph.", 50, 130, 10, true),
    ]);
    expect(paragraphs.map((p) => p.text)).toEqual([
      "Title",
      "This is a paragraph that continues.",
      "Second paragraph.",
    ]);
    const body = bodyFontSize(paragraphs);
    expect(body).toBe(10);
    expect(headingStyle(paragraphs[0].fontSize, body, paragraphs[0].text)).toBe("h1");
    expect(paragraphs[1].bbox).toMatchObject({ x: 50, y: 70, unit: "pt" });
  });
});
