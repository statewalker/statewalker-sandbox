import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/common/markdown-render";

describe("renderMarkdown", () => {
  it("renders CommonMark with source line markers on blocks", () => {
    const html = renderMarkdown("# Title\n\nSome *text*.\n\n- a\n- b\n");
    expect(html).toContain('<h1 data-line="0">Title</h1>');
    expect(html).toContain('<p data-line="2">Some <em>text</em>.</p>');
    expect(html).toContain("<li");
  });

  it("renders GFM-style tables and linkifies URLs", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\nsee https://example.com");
    expect(html).toContain("<table");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it("never passes raw HTML through: file content is data, not code", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("never produces a javascript: link (the text stays inert)", () => {
    const html = renderMarkdown("[x](javascript:alert(1)) and <javascript:alert(2)>");
    expect(html).not.toMatch(/href="\s*javascript:/i);
    expect(html).not.toContain("<a");
  });
});
