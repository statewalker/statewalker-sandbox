# @theia-shell/theia-image-viewer

A Theia extension that opens image files in a zoomable viewer instead of the
text editor: PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG. It is independent of
the other packages: add it to any Theia app's dependencies and it takes over
those file types. It works in browser-only apps and in apps with a backend.

| Contribution | What |
|---|---|
| Open handler | Priority 500 for image extensions (the text editor has 100). *Open With…* still offers the editor. |
| View | The image on a checkerboard, as a `blob:` URL of bytes read through Theia's `FileService`. It reloads when the file itself changes (or an ancestor folder is deleted). If the file can no longer be read, the status line says so, next to a *Reload* button that re-reads it by hand; while it cannot, a change to an ancestor folder (e.g. a mount re-created after a vault unlock) reloads it too — a readable image ignores such changes (a `files.hidden` edit), so its zoom stays. Clicking the image toggles *fit* and *actual size*. A status line shows `width × height · zoom · size`. |
| Navigation | The viewer is `Navigatable`, like a text editor. *Open Editors* lists it, the explorer reveals its file when it becomes active (`explorer.autoReveal`), a rename or move re-opens it at the new name, and deleting the file from the explorer closes it. |
| Commands | *Image: Zoom In*, *Zoom Out*, *Actual Size*, *Fit to Window* |
| Tab toolbar | The same four commands, as buttons on the viewer's tab bar |
| Menu | *View → Image ▸* |
| Keybindings | `=`/`+` zoom in, `-` zoom out, `1` actual size, `0` fit. They apply only while an image viewer is focused (keybinding context `imageViewerFocus`). |

SVG is displayed through `<img>`, so scripts inside an SVG never run. That
matters when files come from other peers (HTTPeers security model, §2).

Styling is Tailwind utility classes coloured by the shadcn/ui tokens. The app
compiles them, as [`app/style`](../../app/style) does. In an app without that
build, the classes have no CSS and the layout falls apart.

Tests: `pnpm test` runs 22 unit tests (MIME types, fit, zoom steps, and which
file changes should trigger a reload). The e2e tests are in
[`app/tests/viewers.spec.ts`](../../app/tests/viewers.spec.ts).
