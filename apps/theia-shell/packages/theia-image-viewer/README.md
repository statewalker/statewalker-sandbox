# @theia-shell/theia-image-viewer

A Theia extension that opens image files in a zoomable viewer instead of the
text editor: PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG. It is independent of
the other packages: add it to any Theia app's dependencies and it takes over
those file types. It works in browser-only apps and in apps with a backend.

| Contribution | What |
|---|---|
| Open handler | Priority 500 for image extensions (the text editor has 100). *Open With…* still offers the editor. |
| View | The image on a checkerboard, as a `blob:` URL of bytes read through Theia's `FileService`. It reloads when the file changes; if the file can no longer be read (deleted, moved), the status line says so. Clicking the image toggles *fit* and *actual size*. A status line shows `width × height · zoom · size`. |
| Commands | *Image: Zoom In*, *Zoom Out*, *Actual Size*, *Fit to Window* |
| Tab toolbar | The same four commands, as buttons on the viewer's tab bar |
| Menu | *View → Image ▸* |
| Keybindings | `=`/`+` zoom in, `-` zoom out, `1` actual size, `0` fit. They apply only while an image viewer is focused (keybinding context `imageViewerFocus`). |

SVG is displayed through `<img>`, so scripts inside an SVG never run. That
matters when files come from other peers (HTTPeers security model, §2).

Tests: `pnpm test` runs 9 unit tests (MIME types, fit, zoom steps). The e2e
tests are in [`app/tests/viewers.spec.ts`](../../app/tests/viewers.spec.ts).
