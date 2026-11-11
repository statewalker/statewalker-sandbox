import { describe, expect, it } from "vitest";
import { fontStyle } from "../src/pdf-extract.ts";
import { layoutText, type TextRun } from "../src/text-layout.ts";

const run = (str: string, x: number, y: number, extra: Partial<TextRun> = {}): TextRun => ({
  str,
  x,
  y,
  width: str.length * 5,
  fontSize: 10,
  hasEOL: false,
  ...extra,
});

describe("font styles", () => {
  it("reads bold and italic from flags and names, including TeX fonts", () => {
    expect(fontStyle({ name: "ABCDEF+Helvetica-Bold" })).toEqual({ bold: true, italic: false });
    expect(fontStyle({ name: "Times-Italic" })).toEqual({ bold: false, italic: true });
    expect(fontStyle({ name: "UMETRW+CMBX10" })).toEqual({ bold: true, italic: false });
    expect(fontStyle({ name: "XYZABC+CMTI10" })).toEqual({ bold: false, italic: true });
    expect(fontStyle({ name: "CMR10", bold: true })).toEqual({ bold: true, italic: false });
    expect(fontStyle({ name: "CMMI10" })).toEqual({ bold: false, italic: false });
  });
});

describe("layoutText", () => {
  it("keeps bold and italic as spans with spaces outside them", () => {
    const { paragraphs } = layoutText([
      run("Plain ", 0, 100),
      run("bold", 30, 100, { bold: true }),
      run(" and ", 50, 100),
      run("italic", 75, 100, { italic: true }),
    ]);
    expect(paragraphs[0].spans).toEqual([
      { text: "Plain ", bold: false, italic: false },
      { text: "bold", bold: true, italic: false },
      { text: " and ", bold: false, italic: false },
      { text: "italic", bold: false, italic: true },
    ]);
  });

  it("detects bullet and numbered items, nesting and a separately drawn number", () => {
    const { paragraphs } = layoutText([
      run("• First", 10, 100),
      run("• Second", 10, 116),
      run("– Nested", 30, 132),
      run("1.", 10, 160),
      run("Step", 40, 160),
    ]);
    expect(paragraphs.map((p) => [p.text, p.list?.type, p.list?.level])).toEqual([
      ["First", "bullet", 1],
      ["Second", "bullet", 1],
      ["Nested", "bullet", 2],
      ["Step", "number", 1],
    ]);
  });

  it("finds an aligned table and leaves prose alone", () => {
    const rows = [
      ["Name", "City", "Size"],
      ["Anna", "Rome", "3"],
      ["Bert", "Oslo", "12"],
    ];
    const runs = rows.flatMap((cells, r) =>
      cells.map((c, k) => run(c, 10 + k * 100, 200 + r * 15, { bold: r === 0 })),
    );
    runs.push(run("A paragraph of prose below the table.", 10, 300));
    const { tables, paragraphs } = layoutText(runs);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual(rows);
    expect(tables[0].headerRows).toBe(1);
    expect(paragraphs.map((p) => p.text)).toEqual(["A paragraph of prose below the table."]);
  });

  it("does not take two columns of prose for a table", () => {
    const left = "This is a long line of text in the left column of a page";
    const right = "and this is a long line of text in the right column too";
    const runs = [0, 1, 2].flatMap((i) => [
      run(left, 10, 100 + i * 14, { width: 280 }),
      run(right, 320, 100 + i * 14, { width: 280 }),
    ]);
    const { tables, paragraphs } = layoutText(runs);
    expect(tables).toHaveLength(0);
    expect(paragraphs).toHaveLength(2);
  });
});
