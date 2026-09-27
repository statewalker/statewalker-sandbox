# @theia-shell/theia-file-panels

Midnight-Commander-style file panels for the theia-shell app: one-folder views in the main area,
a breadcrumb whose segments list their sibling folders, the explorer's file commands, and
copy/move by drag and drop and by menu commands. Design:
[`docs/specs/2026-09-26-file-panels-design.md`](../../docs/specs/2026-09-26-file-panels-design.md).

## Opening a panel

- **View → Open Files Panel** (also in the command palette) opens a panel at the first workspace
  root.
- **Open in Files Panel**, on the explorer's context menu for a folder (or for a file → its
  parent folder), opens one there.
- A new panel opens **split to the right** of the current panel; from anywhere else, as a tab in
  the main area.

## The panel

One folder, flat: folders first, then files, sorted by the active column — name (with
`Intl.Collator`, `file2` before `file10`), size or modified — ascending or descending; clicking a
column header sorts by it, clicking again reverses. The column headings are an ARIA table
(`role="table"` > `role="row"` > `role="columnheader"` with `aria-sort`, a `<button>` inside each)
over Theia's own tree rows, not a literal `<table>`.

- **Toolbar**: Go Up, Refresh (tab-bar toolbar items of the active panel, not buttons inside it).
- **Keys inside the list** are tree-local, not keybindings: arrows move, Shift/Ctrl extend the
  selection, Enter opens (folder → navigate, file → open), Backspace goes up.
- **Opening a file** goes through Theia's own open handler, exactly as the explorer does — the
  editor lands in the panel's tab group, over the panel (Theia's normal tab behaviour;
  `FilePanelModel.doOpenNode` does not change it).
- **Freshness**: the tree refreshes on file-system change events for its folder. If the folder is
  deleted or renamed from elsewhere, the panel falls back to its nearest existing ancestor (or the
  first workspace root) and shows a short notice; a listing failure shows inline with **Retry**,
  not a toast.
- The panel's layout (folder, sort) is restored after a reload.

## Breadcrumb

Segments run from the workspace root that contains the current folder down to it; clicking one
navigates there. An overflowing path collapses its middle segments into **…**, which opens a list
of the hidden ones.

Every segment has a **▾** that opens a popup of its **sibling folders** — read fresh on open, so
never stale — with the current one marked; for the first segment, the siblings are the other
workspace roots. Arrows, Enter and Esc work in the popup; it closes on an outside click or a focus
change. Each segment is also a drop target.

## Drops and transfers

| Source ↓ · Target → | Into a panel | Into the explorer |
|---|---|---|
| From a panel | Dialog: Copy / Move / Rename | Theia's own rule — a plain drop moves, Ctrl (⌥ on macOS) copies, no dialog |
| From the explorer | Dialog: Copy / Move / Rename | Theia's own drop, unchanged |
| From the operating system | Uploaded, no dialog | Theia's own upload, unchanged |

- A drop **onto the source folder itself** never offers Move (moving something onto its own folder
  is meaningless): one item offers Copy and Rename; several items offer Copy only, each getting a
  free name. Dropping a folder onto itself or one of its own descendants is rejected with a
  warning instead, not offered in the dialog.
- **Several items with a clash**: one choice for the batch — Overwrite, Keep both (free names) or
  Skip — shown with the clash count. Clashes **between the dropped sources themselves** never
  overwrite: under Overwrite the later one still gets a free name (overwriting something this same
  batch just wrote would lose data); under Keep both it also gets a free name; under Skip it is
  skipped.
- **Uploads.** Theia's `FileUploadService` enumerates a drop through WebKit filesystem entries; a
  `DataTransfer` built without them (as any script-driven drop is) uploads nothing through that
  path, so `FileDropHandler` falls back to Theia's own exported `CustomDataTransfer`, built
  directly from the dropped files, whenever no entry resolves. A genuine OS drag keeps the native
  path, folder support included. Either way, Theia's own upload-complete handling auto-opens a
  single freshly uploaded file — true for any single-file upload anywhere in the app, not
  something this package can opt out of.
- **Drag payload**: `theia-editor-dnd` (Theia's own URI list, so editors, the shell and other
  panels all understand it) plus a panel-only marker, `theia-file-panels/uris`, by which the
  explorer recognises a panel drag. A browser clears a `DataTransfer` once the drop event's
  synchronous phase ends, so every drop handler in this package reads it in full **before its
  first `await`**.

## Context menu

- **Open** is the panel's own command, acting on the panel's selection (the navigator's own `Open`
  acts on the navigator's selection instead, which is why it is not reused here).
- **Open With…, Rename, Delete, New File, New Folder, Duplicate, Copy Path, Reveal in Explorer**
  are Theia's own commands, acting on the selection this panel publishes to `SelectionService` —
  their dialogs, confirmations and localization included.
- **Copy to Other Panel… / Move to Other Panel…**: enabled once another panel with a folder is
  open. With exactly one other panel it is the target; with more, a quick pick chooses one. Opens
  the same transfer dialog, preset to that choice.
- The menu has its own path (`FILE_PANEL_CONTEXT_MENU`), independent of the explorer's layout.

## Extension rule

The explorer's own behaviour never changes; it gains exactly one case, a drag from a panel.
`PanelAwareNavigatorWidget extends FileNavigatorWidget` and overrides only the protected
`handleDropEvent`: with no panel marker in the drop it defers to `super.handleDropEvent`
untouched, so explorer→explorer drags and OS uploads are exactly as stock Theia; with the marker
present, it resolves the target and operation through the two other protected members it calls,
`getDropTargetDirNode` and `getDropEffect` (Ctrl/⌥ copies, otherwise moves), and carries it out
through the model's own public `copy`/`move` — no dialog. These three protected members of
`FileTreeWidget` are the whole of this package's reach into Theia: no private members, no copies
of Theia internals.

## Internationalization

- Every user-visible string is a function in `src/common/file-panels-nls.ts` that calls
  `nls.localize("theia-shell/file-panels/<key>", "<English default>", ...)` with a string-literal
  key and default, so `theia nls-extract` can find it; no message is built by concatenation.
- Plural messages (item counts) pick a CLDR category with `Intl.PluralRules` and carry one literal
  key per category they can hit (`zero | one | two | few | many | other`); every category but
  `one` defaults to the same `other` English text.
- Sizes (`Intl.NumberFormat`, `style: "unit"`), dates (`Intl.DateTimeFormat`) and name ordering
  (`Intl.Collator`) are formatted through `Intl`, not through message keys — they follow the
  platform's locale, not a translation catalog.
- **No translation provider yet**: browser-only Theia binds a stub `AsyncLocalizationProvider`
  that always resolves `en`. This package only guarantees every string is localizable; an actual
  non-English UI is separate, app-wide work.

## Known limits

- **Non-atomic cross-mount moves.** A move across mounts is copy-then-remove inside the composite
  file system, not a single operation; a failure partway through can leave a copy at the
  destination while the source still exists.
- **Only the explorer accepts a panel drag.** Other Theia file trees (the file-open dialog, the
  editor breadcrumb's folder popup) are not extended; dropping a panel row onto one does nothing,
  as today.
- **The workspace's "Files" root (`file:///`) is read-only** in this app (it is wrapped read-only
  in the mount table), so a panel opened there can list it but not write to it — the same as for
  the explorer.

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
| 10 the explorer accepts panel drags (e2e `file-panels.spec.ts`) | 1 failed, 1 passed (new tests only) | 19 passed |
| 11 Copy / Move to Other Panel (e2e `file-panels.spec.ts`) | 1 failed, 19 passed | 20 passed |
| 12 restore after reload; vanished folders (e2e `file-panels.spec.ts`) | 2 failed, 20 passed | 22 passed |

## Notes

- `biome.json`'s `javascript.parser.unsafeParameterDecoratorsEnabled` (in `apps/theia-shell`,
  repo-wide) is needed for `FilePanelTreeWidget` and `PanelAwareNavigatorWidget`, whose
  constructors take `@inject(...)` parameters — not property injection like the rest of this
  package — because each must forward them to `super(props, model, contextMenuRenderer)`, exactly
  like the Theia classes they extend.
