import { createTextPdf } from "@theia-shell/theia-pdf-viewer/lib/common/text-pdf";
import { createPng } from "./png";
import type { Seed } from "./seed-if-empty";

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
  <rect width="240" height="120" rx="16" fill="#1f6feb"/>
  <circle cx="60" cy="60" r="32" fill="#fff" opacity="0.9"/>
  <text x="108" y="72" font-family="sans-serif" font-size="32" fill="#fff">Theia</text>
</svg>
`;

/** The sample tree written into an empty FilesApi. */
export const SEED: Seed = {
  "/media/gradient.png": createPng(320, 200, (x, y) => [
    Math.round((x / 319) * 255),
    Math.round((y / 199) * 255),
    160,
    255,
  ]),
  "/media/logo.svg": LOGO_SVG,
  "/docs/sample.pdf": createTextPdf([
    "A sample PDF",
    "Stored in the FilesApi, rendered by EmbedPDF",
    "(PDFium compiled to WebAssembly).",
  ]),
  "/welcome.md": [
    "# Welcome",
    "",
    "A Markdown editor running entirely in the browser: Eclipse Theia over a `FilesApi`.",
    "",
    "## Getting started",
    "",
    "Open a file from the explorer, edit it, and save with Ctrl+S.",
    "",
    "## Files",
    "",
    "Everything you see is served by `@statewalker/webrun-files`.",
    "",
    "## Markdown",
    "",
    "Use *Markdown: Open Preview to the Side* and *Markdown: Show Outline*.",
    "",
  ].join("\n"),
  "/notes/ideas.md": [
    "# Ideas",
    "",
    "- A shell for the mesh",
    "- Components installed at runtime",
    "",
    "Plain line",
    "",
    "Another line",
    "",
  ].join("\n"),
  "/docs/cheatsheet.md": [
    "# Cheatsheet",
    "",
    "| Syntax | Result |",
    "|---|---|",
    "| `**bold**` | **bold** |",
    "| `_italic_` | _italic_ |",
    "| `[link](https://example.com)` | [link](https://example.com) |",
    "",
    "```js",
    "# not a heading",
    "```",
    "",
  ].join("\n"),
};
