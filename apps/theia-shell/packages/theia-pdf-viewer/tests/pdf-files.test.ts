import { describe, expect, it } from "vitest";
import { isPdfPath } from "../src/common/pdf-files";

describe("isPdfPath", () => {
  it("matches .pdf case-insensitively and nothing else", () => {
    expect(isPdfPath("/a/b.pdf")).toBe(true);
    expect(isPdfPath("/a/B.PDF")).toBe(true);
    expect(isPdfPath("/a/pdf")).toBe(false);
    expect(isPdfPath("/a/b.pdf.txt")).toBe(false);
  });
});
