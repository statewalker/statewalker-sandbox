# Restore after mount — fix plan

**Branch:** `fix/theia-shell-restore-after-mount` (from `main` at `3b6ab30`).
**Found by:** manual testing on 2026-09-27, each reproduced in a clean Chromium against RustFS.

All paths are relative to `apps/theia-shell/`.

## The problems

1. **Moving or copying a file within an S3 mount fails** with "1 of 1 item failed …: Failed to
   fetch". `S3FilesApi.copy/move` sends `CopyObject`, whose `x-amz-copy-source` header is not in
   the CORS `AllowedHeaders` that `tools/rustfs.mjs` sets (`S3_BROWSER_HEADERS`) — the browser's
   preflight gets a 403. The S3 README tells people to use that list for real buckets too. No test
   copies or moves within S3.
2. **Opened files are not restored after a reload.** Theia awaits every
   `FrontendApplicationContribution.onStart` and then restores the layout
   (`FrontendApplication.start` → `startContributions` → `initializeLayout`). The mounts extension
   only makes the *main* storage ready by then; configured mounts are applied later
   (`MountService.doStart`: after `preferences.ready`), and an S3 mount stays `locked` (an empty
   placeholder) until the vault is unlocked. So restore runs against missing files:
   - a text editor (Monaco) on a mounted file is **dropped** from the layout;
   - the image/PDF viewers show "cannot be read (deleted or moved?)" and **never recover**: when a
     mount is (re)created, `MountTable.apply` announces only `updated /<key>`, and Theia's
     `FileChangesEvent.contains(uri)` matches an ancestor only for deletions, so
     `event.contains(fileUri)` in the viewers is never true.
3. **A file panel on a mount that is locked at reload** falls back to the mount root ("“Docs” no
   longer exists — showing “Cloud (locked)”"), stays there after the unlock, and keeps the stale
   "(locked)" label in its breadcrumb, title and notice (computed once, at navigation time).

## Tasks

### T1 — S3 copy and move work (CORS)
- Add `x-amz-copy-source` (and `x-amz-metadata-directive`) to `S3_BROWSER_HEADERS` in
  `tools/rustfs.mjs`; keep the README's CORS paragraph accurate (say why the header is needed).
- Red→green e2e in `app/tests/s3.spec.ts`: within one S3 mount, move a file into a sub-folder and
  copy a file (e.g. through the FilesApi or a file panel) — the object is where it should be in
  the bucket, and for the move, gone from the source. It must fail before the header change.

### T2 — Restore waits for the mounts, and reopens what could not be restored
- **Startup gate.** Before the layout is restored, wait until every configured, mounted-flag mount
  has settled: `mounted`, `failed`, or `needs-access` (a local folder — only a click can grant it;
  do not wait for it). A mount that needs the vault waits until the vault prompt is answered
  (unlocked, or dismissed). Bound the wait with a timeout so startup can never hang; on timeout,
  continue. Implement it as an `onStart` of a mounts-package contribution (Theia awaits `onStart`
  before restoring), or the equivalent public mechanism you find — no private Theia members.
  Find how and when the vault prompt appears at startup today (theia-secret-vault) and make the
  gate cooperate with it rather than open a second prompt.
- **Reopen after mounting.** A tab that still could not be restored (its mount came up later:
  `needs-access` until Reconnect, vault dismissed then unlocked, timeout) must reopen by itself
  once its file becomes readable. Theia drops such widgets during `ShellLayoutRestorer`; capture
  the widget descriptions that failed (factory id + options) through a public/protected extension
  point, and re-create them (`WidgetManager.getOrCreateWidget` + `ApplicationShell.addWidget`, in
  their area) when the mount they live on becomes `mounted`. Keep it scoped to file-backed widgets
  under a mount; everything else keeps Theia's behaviour.
- Red→green e2e (Docker/RustFS, like `s3.spec.ts`): open a Markdown file and a PDF from an S3
  mount, reload, unlock → the editor tab is back with its text, and the PDF renders. Plus: dismiss
  the unlock prompt at reload, unlock later with *Secrets: Unlock* → both tabs come back.

### T3 — Viewers recover, and can be reloaded by hand
- Image and PDF viewers (and any other file view in this repo with the same "cannot be read"
  state — check `theia-markdown`'s preview) reload when **an ancestor** of their file changes
  (a mount re-created), not only the file itself.
- Next to the "cannot be read" message, a **Reload** button (localized where the package already
  localizes; otherwise match the package's existing string style) that re-reads the file; while it
  still cannot be read, the message stays.
- Red→green: unit tests for any pure helper; e2e: a viewer whose file is missing shows the message
  and a Reload button; the file is created; the viewer shows it (automatically, and by clicking
  Reload in a case where no change event arrives — e.g. restore the file behind the FilesApi's
  back, or through an ancestor change).

### T4 — File panels follow label changes and return to their folder
- Breadcrumb, tab title and notice re-render on `LabelProvider.onDidChange` (the notice stores the
  URIs it names, not a frozen string).
- A panel that fell back because its folder was unavailable remembers the requested folder and
  returns to it (clearing the notice) once that folder exists again — e.g. after a vault unlock or
  a Reconnect. Navigating elsewhere by hand forgets it.
- Red→green: e2e with an S3 mount — panel in `Docs`, reload with the vault prompt dismissed, unlock
  later → the panel is back in `Docs`, no "(locked)" anywhere, no stale notice. Plus a unit test
  for any pure helper.

## Constraints (standing)

- Theia is extended only through exported classes/types and their public or protected members;
  no private members, no copied internals. Standard widgets' default behaviour does not change
  beyond what a task states.
- No keybindings. i18n: `theia-file-panels` strings via its `Messages` catalog (literal keys);
  other packages follow their own existing convention.
- Every behaviour change starts with a test that fails; docs (package READMEs, the specs under
  `docs/specs/`) are updated where they describe changed behaviour.
- E2E in a worktree: `E2E_PORT=31xx`, never 3100. S3 tests need Docker (RustFS), like `s3.spec.ts`.
