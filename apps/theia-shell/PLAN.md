# theia-shell — plan

> **Status (2026-09-25): done.** P1–P7 answered (see each `protos/pN-*/README.md`
> and the summary in `README.md`); the app is in `app/` with 125 unit and 50 e2e tests
> (the prototypes add 12 more e2e). P7, the image/PDF viewers, and the mounts and
> vault came after the plan below was written; they are recorded here, not planned.
> The mounts and vault have their own
> [design](docs/specs/2026-09-25-pluggable-files-api-design.md) and
> [plan](docs/plans/2026-09-25-pluggable-files-api.md).

Goal: an **in-browser-only** Eclipse Theia application (no backend process) that

- shows a **file explorer** over a provided `FilesApi` instance (`@statewalker/webrun-files`),
- opens files in an **editor** and saves them back to that `FilesApi`,
- ships an **extension** contributing **commands, menus and views** — a Markdown
  editor (new file, live preview, outline),

as the first rung toward the HTTPeers shell (a Theia-based host for mesh apps and
dynamically installed components; see `httpeers/docs/security-model.md` §6).

Theia 1.76.0 (released 2026-09-25) is the first release with browser-only plugin
serving (eclipse-theia/theia#17966). Everything below targets it.

## Method

Prototypes first, then the app. Each prototype answers **one** question with a test,
and each piece of code is written red → green: the test is written and run failing
first, then the minimum code to make it pass. The red run is recorded in the
prototype's `README.md` next to the green one.

- **Unit tests** (vitest, Node) for pure logic: the `FilesApi` adapter, Markdown
  outline/preview rendering.
- **End-to-end tests** (Playwright, Chromium) for anything that needs the real
  Theia frontend: the built app is served as plain static files — no backend — and
  driven through the UI.

## Prototypes

| # | Question | Evidence (test) |
|---|---|---|
| **P1** browser-only shell | Does a minimal `"target": "browser-only"` Theia app build in this toolchain (pnpm, Node 22) and render from a static file server with no backend? What does it cost (bundle size, build time)? | e2e: the application shell and its main menu render; no failed requests to a backend. |
| **P2** `FilesApi` → `FileSystemProvider` | Can Theia's `FileSystemProvider` contract (stat, readdir, readFile, writeFile, mkdir, delete, rename, change events) be implemented over `FilesApi` alone? How do missing files, overwrite/create flags and errors map? | unit: an adapter test suite against `MemFilesApi`. |
| **P3** explorer over `FilesApi` | How is the provider swapped into a browser-only app (which binds its own OPFS provider for `file:`), and how is a workspace root opened without a backend so the navigator shows it? | e2e: the explorer lists the seeded files and folders. |
| **P4** editor + save | Does the Monaco editor work browser-only, and does *Save* go through the adapter to the `FilesApi`? | e2e: open a file, type, save; the `FilesApi` holds the new text. |
| **P5** extension contributions | A Theia extension contributing a command, a keybinding, a main-menu item, an explorer context-menu item and a view — all working browser-only. | e2e: run from the command palette, from the menu, open the view. |
| **P6** VS Code web extension | The dynamic-install path: can a static VS Code *web* extension (`browser` entry) run in the browser-only plugin host, and what is the seam a runtime installer would replace? | e2e: the plugin's command is in the palette and runs. Findings recorded even if negative. |

P1–P5 are required by the app. P6 does not block the app; it is there because
runtime installation of components is what the HTTPeers shell needs next.

| # | Question | Evidence (test) |
|---|---|---|
| **P7** EmbedPDF | Can EmbedPDF (PDFium wasm) be bundled by Theia's esbuild and render a PDF from the `FilesApi` with no request leaving the app? | e2e: a PDF renders; every request stays on the app's origin or `blob:`/`data:`. |

## The app

`apps/theia-shell` is a self-contained pnpm workspace (Theia's dependency tree is
large and needs a hoisted `node_modules`, so it is kept out of the sandbox's root
workspace and lockfile):

```
apps/theia-shell/
  PLAN.md                      this file
  protos/pN-*/                 one folder per prototype: README (question, answer, red/green log), app, tests
  packages/theia-files-api/    Theia extension: FilesApi → FileSystemProvider, `FilesApiSource` binding, workspace root
  packages/theia-markdown/     Theia extension: Markdown commands, menus, preview + outline views
  packages/theia-image-viewer/ Theia extension: image viewer (open handler, zoom commands)
  packages/theia-pdf-viewer/   Theia extension: PDF viewer over EmbedPDF (after P7)
  packages/theia-files-mounts/ Theia extension: mount points over a main storage (after the plan)
  packages/theia-secret-vault/ Theia extension: the encrypted secret vault (after the plan)
  packages/theia-files-s3/     Theia extension: the S3 mount type (after the plan)
  app/                         the browser-only application assembling them
  app/files/                   its defaults (Temporary mount, hidden paths) and the demo seed
```

**How the `FilesApi` is provided.** `theia-files-api` exports a DI symbol
`FilesApiSource` (`() => FilesApi | Promise<FilesApi>`). The app binds it in its
own frontend module; the default demo binding is an in-memory `MemFilesApi` seeded
with sample Markdown, images and a PDF. Any other implementation (browser/OPFS, HTTP, composite, one
served by a mesh peer) is a one-line rebinding.

**Markdown extension contributions.**

- Commands: *New Markdown File*, *Open Preview to the Side*, *Toggle Outline*,
  *Insert Heading / Bold / Link* (editor edits).
- Menus: *File → New Markdown File*; explorer context menu *Open Markdown Preview*;
  editor context menu *Markdown* submenu; editor title / command palette.
- Keybindings for preview and bold.
- Views: **Markdown Preview** (main area, follows the active editor live) and
  **Markdown Outline** (sidebar tree of headings; click reveals the line).
- Loading and saving are the standard Theia editor save flow, which goes through
  the `FilesApi` provider — the extension never touches storage directly.

## Done means

- `pnpm test` (unit) and `pnpm test:e2e` (Playwright against the static build) are
  green in `apps/theia-shell`.
- Each prototype's README records its question, answer, and red/green runs.
- The app README explains how to run it and how to provide a different `FilesApi`.
