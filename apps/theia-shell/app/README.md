# Theia Shell

A Markdown editor with image and PDF viewers, and a member of an
[httpeers](https://github.com/statewalker/httpeers) mesh, built on **Eclipse
Theia 1.76**. It runs entirely in the browser. There is no backend: the build
output is static files. Files come from a
[`FilesApi`](https://github.com/statewalker/webrun-files)
(`@statewalker/webrun-files`).

On the mesh, the app joins from an invitation, shows the peers and what they
serve, lets an admin invite others, chats with the mesh's LLM service (or any
OpenAI-compatible endpoint), and can expose outside HTTP origins to the other
members through a proxy.

![The app: explorer over the FilesApi, the editor, the live preview and the outline](docs/screenshot.png)

| Image viewer | PDF viewer (EmbedPDF) |
|---|---|
| ![Image viewer](docs/image-viewer.png) | ![PDF viewer](docs/pdf-viewer.png) |

| The Mesh view and the LLM chat, as an admin | A member calling the admin's proxy over the mesh |
|---|---|
| ![The Mesh view: the join widget, Invite someone, and the peers with what they serve; the chat over the hub's LLM](docs/mesh-chat.png) | ![The Mesh Proxy view: a request to another peer's proxy route, answered by the outside origin](docs/mesh-proxy.png) |

## Run it

The mesh packages are not on npm yet: they are linked from an
[httpeers](https://github.com/statewalker/httpeers) checkout next to this
repository (`../httpeers`, beside `statewalker-sandbox`), which must be built
first:

```bash
git clone https://github.com/statewalker/httpeers ../httpeers   # from the statewalker-sandbox root's parent
(cd ../httpeers && pnpm install && pnpm -r build)
```

Then:

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

### On a mesh

Open an invitation link whose page is this app (`http://127.0.0.1:3000/?join=…`),
or paste an invitation into the **Mesh** view. For a whole mesh on this
machine (a relay, the httpeers hub daemon with its `llm` service over a fake
LiteLLM, and an outside origin to proxy):

```bash
node tools/mesh-stack.mjs http://127.0.0.1:3000/   # prints admin and member invitations, and a URL minting more
```

Each browser profile is one member. Open a member invitation in a second
profile (or a private window) to see two peers.

### Files

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
| [`packages/theia-httpeers`](../packages/theia-httpeers) | **The mesh member.** `MeshService` (the app's one httpeers `PeerSession`), the **Mesh** view (join widget, invitations, peers), the status-bar item, and `MeshContribution` for extensions that serve on the mesh. |
| [`packages/theia-httpeers-proxy`](../packages/theia-httpeers-proxy) | **The proxy.** Serves `/proxy` on the mesh from a route table; the **Mesh Proxy** view edits it and calls this or another member's proxy. |
| [`packages/theia-llm-chat`](../packages/theia-llm-chat) | **The chat.** The **LLM Chat** view over the mesh hub's LLM service or a custom OpenAI-compatible endpoint, on llm-chat's own core. |
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
pnpm --filter @theia-shell/theia-image-viewer test # 9 unit tests: MIME types, fit, zoom steps
pnpm --filter @theia-shell/theia-pdf-viewer test  # 5 unit tests: the generated PDF
pnpm --filter @theia-shell/app-files test         # 7 unit tests: seeding, the PNG encoder
pnpm --filter @theia-shell/theia-httpeers test    # 8 unit tests: the peers list, status text, rules
pnpm --filter @theia-shell/theia-httpeers-proxy test # 15 unit tests: routing, header hygiene, secrets
pnpm --filter @theia-shell/theia-llm-chat test    # 111 unit tests: llm-chat's core (97, ported) and the setup flow
pnpm --filter @theia-shell/app test:e2e           # 24 Playwright tests against the static build
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
- **on a real mesh** (`tools/mesh-stack.mjs`, started by the tests): an admin
  joins from an invitation link and sees the hub and its LLM service; requests
  a key and chats with the hub's LLM; adds a proxy route; invites a member from
  the Mesh view. The member joins with that link in a browser profile of its
  own, reaches the outside origin through the admin's proxy over the mesh (the
  membership token does not leave the mesh), and is refused a key;
- without a mesh: the Mesh view offers to join; the chat against a custom
  endpoint (a wrong key reported, Markdown rendered, the chat and its settings
  kept across a reload); a proxy route kept across a reload, its credential not.

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
- **The mesh (unit).**
  - `theia-httpeers`: 7 of 7 red against an empty module, then green. A
    further red came from the first live run: the hub is not a member, so the
    mesh view does not list it, and the peers list lost it and its LLM advert.
    1 red, then 8 of 8 green.
  - `theia-httpeers-proxy`: 9 of 9 red, then green. A further 3 of 3 red, then
    green, for `underMount` (see below).
  - `theia-llm-chat`: the 97 tests ported from llm-chat passed unchanged on
    their first run. The setup flow: 14 of 14 red, then green. One red was a
    wrong expectation: `listModels` sorts the ids.
- **The mesh (end to end).** Red against the real mesh found four defects the
  unit tests could not:
  1. The edge never started: `Invalid URL`. `webrun-http-browser` resolved
     its worker scope against `import.meta.url`, which is empty in Theia's
     non-ESM bundle. It is fixed upstream in webrun-wire, with a red test
     first, and patched in `app/esbuild.mjs` until a release carries it.
  2. The hub was missing from the peers list (above).
  3. The *Invite someone* panel never appeared. The join widget reads the
     member's roles from the mesh view, which arrives after the session goes
     live, and it was only updated on session changes.
  4. A peer's call to the proxy answered `404 no route`. The member's mount
     table hands the handler the full path (`/proxy/out/x`); the table now
     sees it re-rooted below the mount.

  Green: 3 of 3 on the mesh and 3 of 3 without one. The full suite is 24 of 24.
