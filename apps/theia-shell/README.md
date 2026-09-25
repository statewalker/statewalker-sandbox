# theia-shell

An Eclipse Theia 1.76 application that runs **only in the browser**. It has a
file explorer over a `@statewalker/webrun-files` `FilesApi`, a Monaco editor
that saves back to it, a Markdown extension contributing commands, menus,
keybindings and views, and separate image and PDF viewer extensions (the PDF
viewer uses EmbedPDF). It is the first rung toward the HTTPeers shell: a Theia
host for mesh apps and components installed at runtime.

**Start with [`app/README.md`](app/README.md)** for running it and for how to
provide a `FilesApi`. [`PLAN.md`](PLAN.md) is the plan this followed:
prototypes first, then the app, red/green TDD throughout.

This is a self-contained pnpm workspace, excluded from the sandbox root
workspace. Theia needs a hoisted `node_modules` and brings a large dependency
tree of its own.

```bash
pnpm install
pnpm build          # every package, prototype and the app
pnpm test           # unit tests (vitest)
pnpm test:e2e       # Playwright, per prototype and app, against the static builds
```

## Layout

```
PLAN.md                     the plan: questions, prototypes, the app
tools/serve.mjs             a plain static file server (all a browser-only app needs)
tools/playwright.base.mjs   shared e2e config: serve <app>/lib/frontend, drive Chromium
tools/probe.mjs             debugging aid: load a served app, print console errors and DOM ids, screenshot
protos/p1…p7                one question each; README = question, answer, red/green log
packages/theia-files-api    FilesApi → Theia file system (extension)
packages/theia-markdown     the Markdown extension
packages/theia-image-viewer the image viewer extension
packages/theia-pdf-viewer   the PDF viewer extension (EmbedPDF)
packages/theia-files-mounts mount points over a main storage; settings under shell-system:
packages/theia-secret-vault the encrypted secret vault behind Theia's KeyStoreService
packages/theia-files-s3     the S3 mount type
app/                        the application, app/files (its defaults and seed), e2e tests
tools/rustfs.mjs            test fixture: RustFS (S3) in Docker, with CORS for the app
```

## Mounts and secrets

The app's file system is a set of **mount points** — browser storage, memory,
folders on the computer, S3 buckets — each a `@statewalker/webrun-files`
`FilesApi` shown as a top-level folder, over a main storage that holds the
settings and a password-protected, WebCrypto-encrypted vault for secrets. See
[`app/README.md`](app/README.md), the
[design](docs/specs/2026-09-25-pluggable-files-api-design.md) and the
[plan](docs/plans/2026-09-25-pluggable-files-api.md).

## What the prototypes established

| # | Question | Answer |
|---|---|---|
| [P1](protos/p1-browser-only) | Does a browser-only Theia app build and run from static files? | Yes. Core alone fails DI; the minimum is core, editor, filesystem, messages, monaco, navigator, preferences and workspace. esbuild builds it in about 3 s. `bundle.js` is 24 MB in development mode. |
| [P2](protos/p2-files-api-provider) | `FilesApi` → `FileSystemProvider`? | Yes, whole-file read/write plus folder copy, with 21 unit tests. Theia's `const enum`s are `undefined` at runtime under esbuild/vitest. |
| [P3](protos/p3-explorer) | How is the provider swapped in, and a workspace opened, without a backend? | Rebind `FileSystemProvider` and `WorkspaceServer`, and reveal the explorer. Theia ignores `theiaExtensions` in the app's own `package.json`. Turn off workspace trust. |
| [P4](protos/p4-editor-save) | Monaco + Save through the adapter? | Works with no extra code. |
| [P5](protos/p5-contributions) | Commands, keybindings, menus and views, browser-only? | Standard APIs, all work. |
| [P6](protos/p6-vscode-extension) | VS Code web extensions, and **runtime deploy**? | Static web extensions run once `activationEvents` are explicit (a 1.76 gap). A 20-line `HostedPluginServer` subclass deploys plugins at runtime with no reload (browser-only never calls `setClient`). `@theia/plugin-ext` roughly doubles the frontend modules, and several of them fail without a backend. |
| [P7](protos/p7-embedpdf) | Can EmbedPDF run inside Theia's bundle, offline, on `FilesApi` bytes? | Yes. PDFium's wasm is embedded through Theia's `dataurl` loader for `.wasm`; jsDelivr fonts, Google Fonts and the stamp manifest are switched off. The bundle grows by about 13 MB in development mode. |

## Next, toward the HTTPeers shell

- **A runtime installer** (building on P6): serve plugin files from a
  `FilesApi` or a mesh peer through a Service Worker (`webrun-http-browser`),
  keep the installed list in IndexedDB, and gate installation on signed
  metadata and user consent (security model §6.1).
- **Trim `@theia/plugin-ext`'s** backend-only modules for browser-only
  deployments.
- **Mesh apps in session origins as Theia widgets** (security model §6.2), and a
  `FilesApi` served by a peer.
