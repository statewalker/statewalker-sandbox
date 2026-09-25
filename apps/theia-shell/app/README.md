# Theia Shell: Markdown

A Markdown editor with image and PDF viewers, built on **Eclipse Theia 1.76**,
that runs entirely in the browser. There is no backend: the build output is static files. Files come from
a [`FilesApi`](https://github.com/statewalker/webrun-files)
(`@statewalker/webrun-files`).

![The app: explorer over the FilesApi, the editor, the live preview and the outline](docs/screenshot.png)

The screenshots show the opt-in shadcn/ui style (*Appearance: Toggle shadcn/ui Style*). The default is stock Theia.

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
| [`packages/theia-shadcn`](../packages/theia-shadcn) | **shadcn/ui.** The components (on Theia's shared React), the tokens, and an opt-in *shadcn/ui style* (`appearance.style`, or *Appearance: Toggle shadcn/ui Style*) that restyles Theia's menus, dialogs, buttons, inputs and toasts with CSS only. The default is stock Theia. Either style works with any colour theme. |
| [`app/files`](files) | **The app's `FilesApi`**: OPFS or memory, plus the seed. |
| [`app/style`](style) | **The app's stylesheet**: Tailwind v4 without preflight over the extensions' sources, plus the shadcn theme. The extensions are styled with Tailwind classes, so an app that uses them must compile those classes too. |
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
pnpm --filter @theia-shell/theia-image-viewer test # 9 unit tests: MIME types, fit, zoom steps
pnpm --filter @theia-shell/theia-pdf-viewer test  # 5 unit tests: the generated PDF
pnpm --filter @theia-shell/theia-shadcn test      # 6 unit tests: cn, the button variants, data-slots
pnpm --filter @theia-shell/app-files test         # 7 unit tests: seeding, the PNG encoder
pnpm --filter @theia-shell/app-style test         # 6 unit tests on the compiled CSS (build first)
pnpm --filter @theia-shell/app test:e2e           # 28 Playwright tests against the static build
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
- a PDF renders in EmbedPDF with no request to any host other than the app;
- the default style is stock Theia: menus and dialogs keep Theia's shape, and
  the shadcn components take the theme's colours;
- *Toggle shadcn/ui Style* switches the look live on a dark theme, the choice
  survives a reload, and toggling again restores stock Theia;
- the shadcn/ui style, by computed style against the tokens:
  - menus and confirm dialogs take shadcn's shape and colours;
  - the tokens follow a theme switch;
  - Theia's own elements get no preflight;
  - the outline's items are shadcn buttons;
  - the preview is typeset with Tailwind Typography;
  - the image status line uses the muted token.

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
- **Viewers, after review.**
  - Unit: `stepZoom` zoomed *in* when zooming out from below the smallest preset
    (a huge image fitted to the view); 1 red, then 9 of 9 green.
  - End to end, reload and delete: 3 of 4 red. Deleting an open image left it
    on screen unchanged; the PDF viewer never reloaded. The SVG reload test was
    already green. The PDF delete test was written after the fix and was never
    seen red. The full suite is 18 of 18.
- **shadcn/ui and Tailwind.**
  - End to end: 6 of 7 red before the change. The preflight test is a guard
    and passed before and after.
  - First green run: 6 of 7. The active menu item's radius stayed 4px, because
    Theia's rule for the item's cells has specificity 0,3,0. It is now 7 of 7,
    and the full suite is 25 of 25.
  - Unit, `app-style`: the excluded-names test was 1 red, then green. The
    `theia-shadcn` unit tests were written with the components and were never
    seen red.
- **Style switch.** The shadcn look became opt-in, on top of any colour theme.
  - End to end: 9 of 10 red. The 3 new default-style tests and the 6 shadcn
    tests, which now switch the style on first, all failed; the preflight guard
    passed.
  - Green: 10 of 10. The full suite is 28 of 28.
  - Unit, `app-style`: the scoping test, that no rule on Theia's classes
    escapes `body.shadcn-ui`, was checked by removing the scope from one rule.
    2 tests failed, and they passed again once the scope was restored.
