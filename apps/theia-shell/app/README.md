# Theia Shell: Markdown

A Markdown editor with image and PDF viewers, built on **Eclipse Theia 1.76**,
that runs entirely in the browser. There is no backend: the build output is static files. Files come from
a [`FilesApi`](https://github.com/statewalker/webrun-files)
(`@statewalker/webrun-files`).

![The app: explorer over the FilesApi, the editor, the live preview and the outline](docs/screenshot.png)

| Image viewer | PDF viewer (EmbedPDF) |
|---|---|
| ![Image viewer](docs/image-viewer.png) | ![PDF viewer](docs/pdf-viewer.png) |

## Run it

```bash
cd apps/theia-shell
pnpm install
pnpm --filter @theia-shell/app build     # the extensions (tsc), then `theia build`
pnpm --filter @theia-shell/app start     # http://127.0.0.1:3000
```

Any static file server works: `app/lib/frontend/` is the whole app.

- `http://127.0.0.1:3000/` stores files in the browser's **Origin Private File
  System** (`getOPFSFilesApi`), so they survive reloads.
- `http://127.0.0.1:3000/?storage=memory` uses an in-memory `MemFilesApi`,
  fresh on every load.

An empty `FilesApi` is seeded with `welcome.md`, `notes/ideas.md`,
`docs/cheatsheet.md`, `docs/sample.pdf`, `media/gradient.png` and
`media/logo.svg`. The PNG and the PDF are generated in code (`app/files/src/png.ts`,
`createTextPdf`), so no binary fixtures are checked in.

## What is in it

| Package | Role |
|---|---|
| [`packages/theia-files-api`](../packages/theia-files-api) | **The file system.** `FilesApiFileSystemProvider` implements Theia's `FileSystemProvider` over a `FilesApi`. The frontend module rebinds `FileSystemProvider` (replacing browser-only OPFS) and `WorkspaceServer` (opening the `FilesApi` root on a first visit), reveals the explorer, and names the root. |
| [`packages/theia-markdown`](../packages/theia-markdown) | **The extension.** Commands, menus, keybindings, the preview and the outline view (below). |
| [`packages/theia-image-viewer`](../packages/theia-image-viewer) | **Image viewer extension.** Opens PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG files in a zoomable view, with commands, tab-toolbar buttons, a *View → Image* menu and keybindings. |
| [`packages/theia-pdf-viewer`](../packages/theia-pdf-viewer) | **PDF viewer extension.** Opens `.pdf` files in [EmbedPDF](https://www.embedpdf.com/) (PDFium in WebAssembly), offline. |
| [`app/files`](files) | **The app's `FilesApi`**: OPFS or memory, plus the seed. |
| `app` | The browser-only Theia application (`"theia": { "target": "browser-only" }`). |

### Markdown extension contributions

| Kind | What |
|---|---|
| Commands | *Markdown: New Markdown File*, *Open Preview to the Side*, *Show Outline*, *Toggle Bold*, *Toggle Italic*, *Toggle Heading*, and *View: Toggle Markdown Outline* |
| Menus | *File → New Markdown File*; explorer context menu *Open Markdown Preview*; editor context menu *Markdown ▸* (Bold, Italic, Heading, Preview); *View → Markdown Outline* |
| Keybindings | Preview `Ctrl+Shift+V`, Bold `Ctrl+Alt+B`, Italic `Ctrl+Alt+I`, Heading `Ctrl+Alt+H` (in a Markdown editor) |
| Views | **Markdown Preview**: main area, split to the right. It renders the shared text model, so unsaved edits show live. **Markdown Outline**: right side bar, lists the active editor's headings; click one to reveal it. |
| Language | Registers `markdown` for `.md` / `.markdown` with a small Monarch tokenizer. A browser-only app without VS Code plugins has no Markdown grammar otherwise. |

Loading and saving are Theia's own editor flow, which goes through the
`FilesApi` provider. The extension never touches storage, apart from *New
Markdown File*, which creates the file through Theia's `FileService`.

The preview treats file content as **data, never code**. markdown-it runs with
`html: false`, so raw HTML is escaped and `javascript:` links are refused, and
the result is also passed through DOMPurify. This follows the HTTPeers security
model (`httpeers/docs/security-model.md` §2): a document fetched from a peer
must never run on the shell's origin.

## Providing a different `FilesApi`

Bind `FilesApiSource` in a frontend module of your own; `app/files` is the
example. The function is called once, on first use, and may be async:

```ts
import { FilesApiRootLabel, FilesApiSource } from "@theia-shell/theia-files-api";
import { ContainerModule } from "@theia/core/shared/inversify";

export default new ContainerModule((_bind, _unbind, _isBound, rebind) => {
  rebind(FilesApiSource).toConstantValue(() => openMyFilesApi()); // any FilesApi
  rebind(FilesApiRootLabel).toConstantValue("My files");
});
```

Put that module in its own package, listed in the app's dependencies with a
`theiaExtensions` entry. Theia ignores `theiaExtensions` in the application's
own `package.json`.

## Tests

```bash
pnpm --filter @theia-shell/theia-files-api test   # 21 unit tests: the FileSystemProvider contract
pnpm --filter @theia-shell/theia-markdown test    # 15 unit tests: outline, rendering, edits
pnpm --filter @theia-shell/theia-image-viewer test # 8 unit tests: MIME types, fit, zoom steps
pnpm --filter @theia-shell/theia-pdf-viewer test  # 5 unit tests: the generated PDF
pnpm --filter @theia-shell/app-files test         # 7 unit tests: seeding, the PNG encoder
pnpm --filter @theia-shell/app test:e2e           # 14 Playwright tests against the static build
```

The e2e tests serve `lib/frontend` with a plain static server and drive
Chromium:

- the explorer, open/edit/save and OPFS persistence;
- *New Markdown File* from the File menu;
- the live preview, from the palette and from the explorer context menu;
- the outline, and revealing a heading;
- *Toggle Bold* from the editor context menu;
- *Toggle Heading* by keybinding;
- images: the viewer opens instead of the editor, zoom works from the tab
  toolbar, the keyboard and the palette, and SVG is shown as an image;
- a PDF renders in EmbedPDF with no request to any host other than the app.

Every test also asserts that the page raised no errors.

## Red / green

- **Unit, `theia-markdown`.**
  - Red: 15 of 15 failing against empty stubs.
  - One further red was a wrong expectation in the test. markdown-it leaves
    `[x](javascript:…)` as inert text rather than dropping it, so the test now
    asserts that no `href` is ever a `javascript:` URL.
  - Green: 15 of 15.
- **Unit, `app-files`.** 2 of 2 red against a stub, then green.
- **End to end, with an empty Markdown module.**
  - Red: 7 of 10 failing. The 3 file tests passed on the P2 and P3 work.
  - The root-label test was failing because of a wrong locator: the single root
    is the explorer section's header, not a tree node.
  - Green: 10 of 10 with the extension.
- **Viewers.**
  - Unit: 8 of 8 red, then green (image logic); 4 of 4 red, then green (PNG
    encoder and binary seeding); 4 of 4 green for `createTextPdf`, whose red run
    was a load failure.
  - End to end: 4 of 4 red before the viewers were added to the app, then 4 of
    4 green. The full suite is 14 of 14.
