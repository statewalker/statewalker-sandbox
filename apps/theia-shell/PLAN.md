# theia-shell — plan

> **Status (2026-09-25): done.** P1–P7 answered (see each `protos/pN-*/README.md`
> and the summary in `README.md`); the app is in `app/` with 57 unit and 18 e2e tests
> (the prototypes add 12 more e2e). P7 and the image/PDF viewers came after the
> plan below was written; they are recorded here, not planned.

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
  app/                         the browser-only application assembling them
  app/files/                   its FilesApi (OPFS, or memory) and the demo seed
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

## Stage 2: the mesh

> **Status (2026-09-27): done.** Three extensions, 134 new unit tests, 6 new e2e
> tests (3 of them on a real mesh on loopback).

Goal: bring httpeers' browser pieces into the app, as Theia extensions over the
published libraries rather than as embedded pages:

- **peers and the hub**: join from an invitation, the member's state, the
  peers and what they advertise, invitations for an admin
  (`httpeers/packages/httpeers-member`, `httpeers-join`);
- **proxy configuration**: expose outside origins to the mesh from this
  browser, call other members' proxies (`httpeers/apps/demos/src/proxy`);
- **the LLM chat**: over the mesh hub's `llm` service, or any
  OpenAI-compatible endpoint (`httpeers/apps/llm-chat`).

**P8, the one open question**: can an httpeers member (libp2p, Biscuit, the
ServiceWorker edge, the join widget) run inside Theia's esbuild bundle and join
a real mesh? It was answered in the app itself, against `tools/mesh-stack.mjs`:
a relay, the hub daemon and a fake LiteLLM on loopback. Yes, with two seams:
the edge's worker is copied to `/sw.js` rather than bundled, and
`webrun-http-browser` needs `import.meta.url`, which a non-ESM bundle does not
have (fixed upstream in webrun-wire; patched in `app/esbuild.mjs` meanwhile).

**Decisions.**

- *One member per app, in a service.* `MeshService` owns the `PeerSession`, and
  every extension goes through it. What an extension serves goes through
  `MeshContribution` (mounts once, adverts on every heartbeat), because the
  member's mount table is fixed when the session is created.
- *Native widgets, ported cores.* llm-chat's core (config, sessions, IndexedDB
  stores, the streaming client, the chat controller, hub discovery) and the
  proxy demo's route store and upstream have no DOM, so they are ported
  unchanged with their tests, and the UI is Theia's own (`ReactWidget`, Theia's
  theme variables). Embedding llm-chat's React tree would have meant a second
  React and Tailwind in the shell. httpeers' rule is that an app never imports
  from another app, so these are ports, not imports.
- *The join widget as is.* `mountJoinWidget` is the one piece every httpeers
  page shares, including its wording and the Invite panel; the Mesh view hosts
  it rather than re-implementing it.
- *httpeers by `link:`.* The libraries are not on npm yet; the workspace links
  a sibling checkout. Publishing them removes this.
- *Security model.* Everything from peers is data: replies are sanitized
  Markdown, a proxy strips the mesh's own headers before an outside origin
  sees the request, secrets are never persisted, and discovery trusts only the
  hub's LLM document and URLs under the hub's own mount.

| Package | Role |
|---|---|
| `packages/theia-httpeers` | `MeshService`, the Mesh view, status bar, commands, `MeshContribution`, `shellRules()` |
| `packages/theia-httpeers-proxy` | the `/proxy` mount and the Mesh Proxy view |
| `packages/theia-llm-chat` | the LLM Chat view over llm-chat's core and a setup state machine for both sources |
| `tools/mesh-stack.mjs` | a whole mesh on loopback, for the e2e tests and by hand |
