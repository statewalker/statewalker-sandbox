import type { Command } from "@theia/core/lib/common/command";

const category = "Markdown";

export namespace MarkdownCommands {
  export const NEW_FILE: Command = { id: "markdown.newFile", category, label: "New Markdown File" };
  export const OPEN_PREVIEW: Command = {
    id: "markdown.openPreview",
    category,
    label: "Open Preview to the Side",
  };
  export const SHOW_OUTLINE: Command = {
    id: "markdown.showOutline",
    category,
    label: "Show Outline",
  };
  export const TOGGLE_BOLD: Command = { id: "markdown.toggleBold", category, label: "Toggle Bold" };
  export const TOGGLE_ITALIC: Command = {
    id: "markdown.toggleItalic",
    category,
    label: "Toggle Italic",
  };
  export const TOGGLE_HEADING: Command = {
    id: "markdown.toggleHeading",
    category,
    label: "Toggle Heading",
  };
}
