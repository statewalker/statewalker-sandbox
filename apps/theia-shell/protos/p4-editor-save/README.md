# P4: editor and save

**Question.** Does the Monaco editor work in browser-only mode, and does *Save*
go through the adapter into the `FilesApi`?

**Answer: yes, with no code beyond P2 and P3.** The app is P3's with a
different name; it reuses `@theia-shell/p3-extension`.

- A double-click in the explorer opens the file in Monaco. The file's text
  comes from `FilesApiFileSystemProvider.readFile`.
- Typing marks the tab dirty (`theia-mod-dirty`). Nothing reaches the
  `FilesApi` until Save.
- Ctrl+S runs Theia's normal save. The `FileService` calls
  `writeFile(uri, bytes, { create: false, overwrite: true })`, and the
  `FilesApi` then holds the new text.
- The Monaco worker (`editor.worker.js`, 3.8 MB) loads from the static server
  with no configuration.

## Red / green

- Red: not built. The double-click timed out because there was no explorer.
- Green on the first build: `✓ open, edit and save a file through the FilesApi (4.4s)`.
  The test was then tightened to assert that the `FilesApi` does *not* have the
  edit before Save; it is still green.
