import { describe, expect, it } from "vitest";
import { parseOutline } from "../src/common/markdown-outline";

describe("parseOutline", () => {
  it("lists ATX headings with level, text and 0-based line", () => {
    const text = "# Title\n\nIntro\n\n## Part one\ntext\n### Detail ###\n## Part two\n";
    expect(parseOutline(text)).toEqual([
      { level: 1, text: "Title", line: 0 },
      { level: 2, text: "Part one", line: 4 },
      { level: 3, text: "Detail", line: 6 },
      { level: 2, text: "Part two", line: 7 },
    ]);
  });

  it("recognises setext headings", () => {
    expect(parseOutline("Title\n=====\n\nSub\n---\n")).toEqual([
      { level: 1, text: "Title", line: 0 },
      { level: 2, text: "Sub", line: 3 },
    ]);
  });

  it("ignores headings inside fenced code and lines that are not headings", () => {
    const text =
      "```md\n# not a heading\n```\n#not-a-heading\n    # indented code\n~~~\n## nope\n~~~\n# Real\n";
    expect(parseOutline(text)).toEqual([{ level: 1, text: "Real", line: 8 }]);
  });

  it("keeps inline markup out of the label", () => {
    expect(parseOutline("## The **bold** and `code` [link](x)")).toEqual([
      { level: 2, text: "The bold and code link", line: 0 },
    ]);
  });

  it("returns nothing for text without headings", () => {
    expect(parseOutline("")).toEqual([]);
    expect(parseOutline("just text\n---\n")).toEqual([{ level: 2, text: "just text", line: 0 }]);
  });
});
