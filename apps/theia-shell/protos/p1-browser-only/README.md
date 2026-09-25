# P1: browser-only shell

**Question.** Can a minimal `"theia": { "target": "browser-only" }` app built with
Theia 1.76 in this toolchain (pnpm with hoisted `node_modules`, Node 22) render
from a plain static file server with no backend? What does it cost?

**Answer: yes, but not with `@theia/core` alone.**

- `@theia/core` on its own builds, but the frontend fails at start with DI errors.
  `PreferenceProvider` comes from `@theia/preferences`, and `QuickInputService`
  and `QuickAccessRegistry` come from `@theia/monaco`.
- The smallest set that works is `core`, `editor`, `filesystem`, `messages`,
  `monaco`, `navigator`, `preferences` and `workspace`. That set is also what
  the app needs anyway.
- Theia 1.76 builds with **esbuild**, not webpack. It generates
  `gen-esbuild.browser.mjs` and an editable `esbuild.mjs`. A development build
  takes about 3 seconds.
- Size: `lib/frontend` is 148 MB in development mode, mostly source maps.
  `bundle.js` is 24 MB. The Monaco worker `editor.worker.js` is 3.8 MB, and a
  `secondary-window.js` is built as well.
- Nothing contacts a backend: no WebSocket, no failed request.
- The filesystem comes from `@theia/filesystem`'s `frontendOnly` module. It
  binds `FileSystemProvider` to `OPFSFileSystemProvider` and wraps it in
  `BrowserOnlyFileSystemProviderServer`. **That binding is the seam P3 rebinds.**
- The workspace comes from `BrowserOnlyWorkspaceServer`, which keeps recent
  workspaces in `localStorage`.

## Test

`tests/shell.spec.ts` checks four things: the shell renders, the main menu shows
*File*, F1 opens the command palette, and there are no page errors, WebSockets
or failed requests.

Red runs:

1. Before building, `#theia-app-shell` was not found.
2. With `@theia/core` only, `#theia-top-panel` stayed hidden. The probe showed
   `No matching bindings found for serviceIdentifier: Symbol(PreferenceProvider)`.

Green: with the eight packages, `✓ the Theia shell renders with no backend (3.4s)`.

```bash
pnpm --filter @theia-shell/p1-browser-only build
pnpm --filter @theia-shell/p1-browser-only test:e2e
```
