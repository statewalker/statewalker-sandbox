# P3: the explorer over a `FilesApi`

**Question.** How is the `FilesApi` provider swapped into a browser-only app,
which binds its own OPFS provider for `file:`? How is a workspace root opened
without a backend, so the navigator shows it?

**Answer.** With three rebinds in one frontend module, now
`packages/theia-files-api/src/browser/files-api-frontend-module.ts`:

1. **`FileSystemProvider` → `FilesApiFileSystemProvider`.**
   - `@theia/filesystem`'s `frontendOnly` module binds `FileSystemProvider` to
     `OPFSFileSystemProvider`.
   - `BrowserOnlyFileSystemProviderServer` wraps whatever `FileSystemProvider`
     is bound, and the frontend registers that for `file:`.
   - An extension that depends on `@theia/filesystem` loads *after* it (see the
     order in `src-gen/frontend/index.js`), so a `rebind` is all it takes.
   - The OPFS provider is never created.
2. **`WorkspaceServer` → `FilesApiWorkspaceServer`.** This subclasses
   `BrowserOnlyWorkspaceServer`, which keeps recent workspaces in
   `localStorage`. When there is no recent workspace it returns
   `FilesApiWorkspaceRoot` (default `file:///`).
3. **Reveal the explorer.** On a first start the navigator adds the explorer
   but leaves the left panel collapsed. `RevealExplorerContribution` calls
   `openView({ reveal: true })` from `initializeLayout`.

The app supplies its `FilesApi` by rebinding `FilesApiSource`
(`() => FilesApi | Promise<FilesApi>`); see `extension/app-module.js`. The
default is an empty `MemFilesApi`.

## Findings

- **Theia ignores `theiaExtensions` in the application's own `package.json`.**
  Only dependencies are scanned. The app's module is therefore a tiny
  workspace package, `extension/`.
- **A hand-written CommonJS module needs `__esModule`.** Without it,
  `import()` gives Theia's loader the whole exports object, and it fails with
  `currentModule.registry is not a function`.
- **Workspace trust.** Opening any folder brings up the *Do you trust the
  authors?* modal, which blocks the UI. The app turns it off with a default
  preference in `package.json`:
  `theia.frontend.config.preferences["security.workspace.trust.enabled"] = false`.
  The HTTPeers shell will want its own trust decision anyway (see the security
  model, §6).
- The root node is labelled `/`, the basename of `file:///`. The app gives it a
  proper name.

## Red / green

- Red 1: not built, so `#files` was not found.
- Red 2: `#files` was hidden. The screenshot showed the trust modal, and the app
  module was not loaded at all.
- Red 3: `currentModule.registry is not a function`, the `__esModule` finding.
- Red 4: `#files` was hidden because the left panel was collapsed. After a click
  on *Explorer*, the screenshot showed `docs/` and `README.md` from the
  `FilesApi`.
- Green: `✓ the explorer lists the FilesApi tree (3.8s)`.
