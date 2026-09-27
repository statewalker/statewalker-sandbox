# @theia-shell/theia-file-panels

Midnight-Commander-style file panels for the theia-shell app: one-folder views in the main area,
a breadcrumb whose segments list their sibling folders, the explorer's file commands, and
copy/move by drag and drop and by menu commands. Design:
[`docs/specs/2026-09-26-file-panels-design.md`](../../docs/specs/2026-09-26-file-panels-design.md).

## Red / green

| Task | Red | Green |
|---|---|---|
| 1 messages, formatting | 0 | 9 |
| 2 sorting | 6 | 6 |
| 3 transfer planning | 18 | 18 |
| 4 breadcrumb model | 7 | 7 |
| 5 transfer runner | 3 | 3 |
| 6 the panel (e2e `file-panels.spec.ts`) | 3 failed | 4 passed |
| 7 breadcrumb sibling dropdowns (e2e `file-panels.spec.ts`) | 3 failed, 4 passed | 7 passed |
| 8 context menu, Open in Files Panel (e2e `file-panels.spec.ts`) | 2 failed, 7 passed | 9 passed |
| 9 drops into panels: dialog, service, drag source, uploads (e2e `file-panels.spec.ts`) | 8 failed, 9 passed | 17 passed |
| 10 the explorer accepts panel drags (e2e `file-panels.spec.ts`) | 1 failed, 17 passed | 19 passed |
| 11 Copy / Move to Other Panel (e2e `file-panels.spec.ts`) | 1 failed, 19 passed | 20 passed |
| 12 restore after reload; vanished folders (e2e `file-panels.spec.ts`) | 2 failed, 20 passed | 22 passed |

## Notes

- `biome.json`'s `javascript.parser.unsafeParameterDecoratorsEnabled` was added for
  `FilePanelTreeWidget`'s constructor (`file-panel-tree-widget.tsx`): it takes `@inject(...)`
  constructor parameters — not property injection like every other class in this package — because
  it must feed `super(props, model, contextMenuRenderer)`, exactly like Theia's own
  `FileTreeWidget` does. Biome's parser rejects parameter decorators without this flag.
- Opening a file from a panel uses Theia's open handler exactly as the spec says ("opening a file
  opens it like the explorer does"); the opened editor lands in the panel's tab group and the
  panel goes to the background — that is Theia's normal tab behaviour, unchanged
  (`FilePanelModel.doOpenNode` was not altered for this).
- **Task 7 environment fix:** `@types/react-dom` was not installed anywhere in the workspace (only
  `@types/react`) — pnpm reported it as a skipped optional peer dependency. `createRoot`
  (`@theia/core/shared/react-dom/client`, which re-exports `react-dom/client`) therefore had no
  type declarations and `tsc` failed with "has no exported member 'createRoot'". Added
  `@types/react-dom: 19.2.7` (the latest version whose peer range accepts the installed
  `@types/react@19.2.18`; `19.3.0` requires `@types/react@^19.3.0` and was rejected) to the
  workspace root's `devDependencies`, matching how `@types/react` is already pinned there.
- **Task 7 accessibility adaptation:** the brief's `folder-breadcrumb.tsx` (a `<span>` drop target,
  and a `<ul role="listbox">`/`<li role="option">` list) fails this repo's Biome a11y lint set
  (`noStaticElementInteractions`, `noNoninteractiveElementToInteractiveRole`,
  `useFocusableInteractive`, `useKeyWithClickEvents`). Adapted minimally, keeping every DOM hook
  and CSS class the spec/tests rely on:
  - The sibling list and its items are `<div role="listbox">` / `<div role="option">` instead of
    `<ul>`/`<li>` (WAI-ARIA's own recommendation — `ul`/`li` carry list semantics that clash with
    listbox/option); each option got `tabIndex={-1}` and its own `onKeyDown` (Enter/Space) so it is
    independently valid per Biome's checks, alongside the container's existing arrow-key/Enter
    navigation.
  - The crumb `<span>` (a drop target wrapping two buttons, not itself clickable) has no native
    element or ARIA role that fits — `role="group"` triggered a further `useSemanticElements`
    nudge toward `<fieldset>`, which is wrong here. Kept the plain `<span>` and added one
    `biome-ignore lint/a11y/noStaticElementInteractions` comment explaining why.
- **Task 9 signature/selector adaptations** (feature design unchanged from the brief):
  - `FileUploadService.UploadResult.uploaded` is `string[]` (URI strings), not path segments, per
    the `.d.ts` — mapped with `new URI(s)` as the brief's own note anticipated.
  - `FileDropHandler`'s OS-upload branch checks `webkitGetAsEntry()` before handing the raw
    `DataTransfer` to `FileUploadService`: a `File` added to a `DataTransfer` via script (as any
    synthetic drop test must) never has a WebKit entry, and the browser-only
    `FileUploadServiceImpl.enumerateFiles` has no fallback for that case — it silently uploads
    zero files. Falling back to a hand-built `CustomDataTransfer` (an exported, documented Theia
    upload-service type) when no item resolves a real entry fixes the test and is arguably more
    robust; a genuine OS drag still uses the native `DataTransfer` path (and its folder support)
    unchanged.
  - The OS-file-upload e2e test dispatches its synthetic `DragEvent`s on
    `.file-panel-tree .theia-TreeContainer`, not `.file-panel-tree` itself: Theia's `TreeWidget`
    wires `onDragOver`/`onDrop` onto the inner `.theia-TreeContainer` div
    (`createContainerAttributes()`), not onto the widget's own outer node — a `dispatchEvent` on
    the outer node never reaches that descendant listener, since native events bubble up, not down.
    (`.file-panel-tree` is still correct as the drop-zone target for the drag-and-drop tests, which
    drive real mouse-based `dragTo()`; the browser resolves those to the actual element under the
    cursor regardless of which ancestor node Playwright's locator names.)
  - Two-panel tests (`twoPanels`) pin each panel to `panels(page).nth(0)`/`nth(1)` rather than
    reusing `openPanel`'s returned `panels(page).last()` locator: `.last()` is evaluated lazily at
    every use, so once a second panel opens, a `const a = await openPanel(page)` captured *before*
    it existed silently starts resolving to the *new* (second) panel instead. `openPanel` itself is
    fine for every single-panel test in this file; only Task 9's cross-panel scenarios exposed it.
  - Two toast assertions (`"Cannot put ... inside itself"`, `"1 of 1 items failed"`) are scoped
    through the existing `toast()` helper instead of a bare `page.getByText(...)`: Theia mirrors
    every notification into the (hidden but present) notification center in addition to the toast,
    so an unscoped `getByText` matches twice and Playwright's strict mode refuses to pick one.
  - **Environment discovery, not a bug in this package:** Theia's own (pre-existing, global)
    `FilesystemFrontendContribution` subscribes to `FileUploadService.onDidUpload` and automatically
    opens a single freshly-uploaded file in an editor, which — like opening any file from a panel
    (see the note above and ruling R8) — covers the panel. This fires for *any* single-file upload
    through `FileUploadService`, not just ours, and isn't something an extension can opt out of.
    The OS-upload e2e test therefore asserts the write against the filesystem
    (`theiaShell.filesApi.exists`), the same technique the "dropping a folder into itself" test
    already uses, rather than asserting the panel still shows the new row.
- **Task 10:** `PanelAwareNavigatorWidget` (`panel-aware-navigator-widget.ts`) subclasses Theia's
  `FileNavigatorWidget` and overrides only `handleDropEvent`: it reads the `theia-file-panels/uris`
  payload synchronously (per the drag-payload-timing note above), and when empty defers to
  `super.handleDropEvent` unchanged — every explorer-native drop (explorer → explorer, an OS-file
  upload) never enters the new branch. When the payload is present, it applies the explorer's own
  drop-effect rule (`getDropEffect`: Ctrl/⌥ copies, otherwise moves) through the model's public
  `copy`/`move`, with no dialog, matching the spec's "explorer's own copy/move rule" requirement.
  `file-panels-frontend-module.ts` now takes `rebind` and rebinds `FileNavigatorWidget` inside a
  *child* of Theia's own navigator container (`createFileNavigatorContainer`), so the
  `WidgetFactory`'s `container.get(FileNavigatorWidget)` resolves to the subclass while the tree,
  model, decorators and props all stay exactly Theia's.
  - Playwright's `dragTo()` from a panel row onto an explorer node carried a real `DataTransfer`
    end to end, including the synthetic `keyboard.down("Control")` reaching the drop event's
    `ctrlKey` (and therefore `getDropEffect`) correctly — the brief's fallback dispatchEvent/
    `ctrlKey: true` technique was not needed for either new test.
  - No signature or behavioural divergence from the brief: the 1.76 `FileNavigatorWidget`
    constructor is exactly `(props, model, contextMenuRenderer)`, matching the brief's three
    parameters with nothing extra to mirror.
- **Task 12:** `FilePanelWidget implements StatefulWidget` (`storeState`/`restoreState`/
  `navigateToExisting`) exactly per the brief; a `files.onDidFilesChange` watcher catches the
  active folder (or an ancestor) disappearing out from under an open panel, not just a restore.
  `navigateTo` clears a `notice` field that `navigateToExisting` sets after moving to the nearest
  existing ancestor, and `updateEmptyState` falls back to it between the error and empty-folder
  cases. No divergence from the brief's design.
  - GREEN surfaced a pre-existing defect outside this task's own files: `file-panel-header.tsx`'s
    `column()` renderer never emitted the `aria-sort` attribute, even though the feature's own
    design doc (`docs/plans/2026-09-26-file-panels.md`) specifies it verbatim on that button —
    an earlier task must have dropped it. The reload test's sort assertion
    (`.file-panel-column[aria-sort=descending]`) is the first test in this suite to check it, so
    the gap went uncaught until now.
  - **Fix round 1 (code review):** `aria-sort` on a `<button>` is invalid ARIA (only
    `columnheader`/`rowheader` support it); the initial fix had papered over this with a
    `biome-ignore`. Restructured each column as `<span role="columnheader" aria-sort={…}>`
    wrapping the actual `<button>` (the click target and tab stop; the span carries `tabIndex={-1}`
    so it is not itself a stray focus stop), inside a `<div role="row">` (also `tabIndex={-1}`),
    matching the ARIA grid-cell pattern — no literal `<table>`, since this is a flex-laid-out
    column bar, not tabular data. Biome's `useSemanticElements` still nudges toward `<th>`/`<tr>`
    for both; kept the `div`/`span` structure (a real `<table>` would fight the existing flex
    layout for no accessibility gain — `role="columnheader"`/`role="row"` outside a literal table
    is the standard div-based ARIA grid pattern) and added one `biome-ignore
    lint/a11y/useSemanticElements` per element, same precedent as the crumb `<span>` note above.
    `useAriaPropsSupportedByRole` no longer fires at all — no ignore needed for it, since
    `aria-sort` is now on the correct role. Moved the button-specific CSS rules (background,
    border, color, cursor, padding, text-align, plus `display: block` and full-width so the
    button fills its cell) from `.file-panel-column` to `.file-panel-column > button`; also split
    the numeric columns' `text-align: end` onto `.file-panel-size > button, .file-panel-modified >
    button` (previously on the same selector as their `flex`/`font-variant-numeric`, which stayed
    on the outer cell) — otherwise the base rule's inherited `text-align: start` on the button
    would have overridden it and mis-aligned the Size/Modified headers. No test edits were needed:
    the click still lands on the inner `<button>` and `.file-panel-column[aria-sort=…]` still
    resolves to the cell.
  - Also hardened the `onDidFilesChange` watcher: the `files.exists(folder)` check is async, so a
    user could navigate the panel elsewhere while it was pending; the `.then` now re-checks
    `this.folder?.isEqual(folder)` before calling `navigateToExisting`, so a stale check can no
    longer undo a navigation made in the meantime.
  - **Fix round 2 (code review):** ARIA's `row` role requires an ancestor with role
    `table`/`grid`/`treegrid`/`rowgroup` (axe's `aria-required-parent`), which
    `.file-panel-columns` (`role="row"`) didn't have. Wrapped it in a new
    `.file-panel-column-bar` div with `role="table"`, giving the row its required table context —
    the smallest valid structure, still no literal `<table>` (this stays a flex-laid-out bar, not
    tabular markup). The new wrapper needed no CSS: an unstyled block div around the existing flex
    row doesn't change layout. Re-tested whether `tabIndex={-1}` on the row/columnheaders was still
    needed now that they have valid ARIA parents: Biome's `useFocusableInteractive` still fires
    without it (the table ancestor doesn't change that rule's requirement), so both attributes
    stayed, each with a one-line rationale where a `biome-ignore` is used. Three
    `biome-ignore lint/a11y/useSemanticElements` comments now stand — table wrapper, row, and each
    columnheader — one per div/span Biome would rather see as `<table>`/`<tr>`/`<th scope="col">`;
    none needed for `useFocusableInteractive` since `tabIndex={-1}` resolves that rule outright.
