import { describe, expect, it } from "vitest";
import { createTextPdf } from "../src/common/text-pdf";

const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

describe("createTextPdf", () => {
  const bytes = createTextPdf(["Hello PDF", "Second line"]);
  const text = latin1(bytes);

  it("is a PDF: header, trailer, EOF marker", () => {
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text).toMatch(/trailer\s*<<\s*\/Size 6\s*\/Root 1 0 R\s*>>/);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("has a cross-reference table whose offsets point at each object", () => {
    const startxref = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = text
      .slice(startxref)
      .split("\n")
      .filter((l) => / 00000 n $/.test(l))
      .map((l) => Number(l.slice(0, 10)));
    expect(entries).toHaveLength(5);
    entries.forEach((offset, i) => {
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it("states the content stream's exact length", () => {
    const match = /\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(text);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(match?.[2].length);
  });

  it("draws every line, escaping PDF string delimiters", () => {
    expect(text).toContain("(Hello PDF) Tj");
    expect(text).toContain("(Second line) Tj");
    expect(latin1(createTextPdf(["a (b) \\ c"]))).toContain("(a \\(b\\) \\\\ c) Tj");
  });
});
