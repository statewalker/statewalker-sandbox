import { describe, expect, it } from "vitest";
import {
  isMarkdownPath,
  nextUntitledName,
  toggleHeading,
  toggleWrap,
} from "../src/common/markdown-edits";

describe("toggleWrap", () => {
  it("wraps a selection with the marker", () => {
    expect(toggleWrap("word", "**")).toBe("**word**");
    expect(toggleWrap("two words", "_")).toBe("_two words_");
  });

  it("unwraps an already wrapped selection", () => {
    expect(toggleWrap("**word**", "**")).toBe("word");
    expect(toggleWrap("_word_", "_")).toBe("word");
  });

  it("inserts an empty pair for an empty selection", () => {
    expect(toggleWrap("", "**")).toBe("****");
  });
});

describe("toggleHeading", () => {
  it("cycles a line through heading levels 1..6 and back to text", () => {
    expect(toggleHeading("Title")).toBe("# Title");
    expect(toggleHeading("# Title")).toBe("## Title");
    expect(toggleHeading("###### Title")).toBe("Title");
  });
});

describe("nextUntitledName", () => {
  it("picks the first free untitled name", () => {
    expect(nextUntitledName([])).toBe("untitled.md");
    expect(nextUntitledName(["untitled.md"])).toBe("untitled-2.md");
    expect(nextUntitledName(["untitled.md", "untitled-2.md", "untitled-4.md"])).toBe(
      "untitled-3.md",
    );
  });
});

describe("isMarkdownPath", () => {
  it("accepts .md and .markdown, case-insensitively", () => {
    expect(isMarkdownPath("/a/README.md")).toBe(true);
    expect(isMarkdownPath("/a/notes.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("/a/notes.txt")).toBe(false);
    expect(isMarkdownPath("/a/md")).toBe(false);
  });
});
