import MarkdownIt from "@theia/core/shared/markdown-it";

/**
 * Markdown → HTML for the preview. File content is data, never code (see the
 * HTTPeers security model): raw HTML is escaped (`html: false`) and
 * markdown-it's link validation drops `javascript:` and similar URLs.
 * Every block carries `data-line` (its first source line, 0-based) so the
 * preview can follow the editor.
 */
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

md.core.ruler.push("source_lines", (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1) token.attrSet("data-line", String(token.map[0]));
  }
});

export function renderMarkdown(text: string): string {
  return md.render(text);
}
