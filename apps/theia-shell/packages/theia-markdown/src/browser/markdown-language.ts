import * as monaco from "@theia/monaco-editor-core";

/**
 * A browser-only app without VS Code plugins has no Markdown grammar. This
 * registers the `markdown` language for .md files with a small Monarch
 * tokenizer, so `editorLangId == markdown` works and the text is highlighted.
 */
export function registerMarkdownLanguage(): void {
  if (monaco.languages.getLanguages().some((l) => l.id === "markdown")) return;
  monaco.languages.register({
    id: "markdown",
    extensions: [".md", ".markdown"],
    aliases: ["Markdown", "markdown"],
  });
  monaco.languages.setLanguageConfiguration("markdown", {
    comments: { blockComment: ["<!--", "-->"] },
    brackets: [
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "`", close: "`" },
    ],
  });
  monaco.languages.setMonarchTokensProvider("markdown", {
    tokenizer: {
      root: [
        [/^\s*#{1,6}\s.*$/, "keyword"],
        [/^\s*```.*$/, { token: "string", next: "@fence" }],
        [/^\s*>.*$/, "comment"],
        [/^\s*([-*+]|\d+[.)])\s/, "keyword"],
        [/\*\*[^*]+\*\*|__[^_]+__/, "strong"],
        [/\*[^*]+\*|_[^_]+_/, "emphasis"],
        [/`[^`]+`/, "string"],
        [/!?\[[^\]]*\]\([^)]*\)/, "type.identifier"],
      ],
      fence: [
        [/^\s*```\s*$/, { token: "string", next: "@pop" }],
        [/.*$/, "string"],
      ],
    },
  });
}
