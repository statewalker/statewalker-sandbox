# File panels — design

Status: agreed in conversation 2026-09-26; awaiting review of this written form.

## Goal

**File panels**: any number of file-manager widgets, each showing **one folder** as a flat list —
in the spirit of Midnight Commander or Google Drive — opened as tabs in the main area so two or
more can sit side by side.

- Navigate by opening folders, going up, or through a **breadcrumb** whose every segment has a
  **▾ dropdown listing the sibling folders** at that level.
- Open, rename, delete, create files and folders from a panel, exactly as from the explorer.
- **Copy / move** between panels and the explorer, in every direction, by drag and drop and by
  context-menu commands.
- Every drop **into a panel** (from a panel or from the explorer) asks, in a dialog, whether to
  **copy** or **move/rename**. When the target folder is the source folder, only **copy** or
  **rename** is offered.
- Drops **into the explorer keep Theia's default behaviour** — Ctrl (⌥ on macOS) copies, a plain
  drop moves, no dialog. A drag coming from a panel follows that same rule.
- Columns (name, size, modified) with sorting; files dropped from the operating system are
  uploaded; open panels come back after a reload.
- **Internationalized from the start**: no user-visible string, number, date or sort order is
  hard-coded to English.

## Non-goals

- **No keybindings.** No F5/F6/Tab-style bindings; actions are menu commands and drag and drop.
  Keys *inside* a focused list (arrows, Enter, Backspace) are the tree's own handling, not
  registered keybindings.
- **No translation provider.** Browser-only Theia binds a stub `AsyncLocalizationProvider`
  (always `en`, no translations). Making the app load real translations is app-wide work, filed
  as its own issue; this feature only guarantees every string is localizable.
- No undo, no background transfer queue, no rollback of a partly failed batch.
- No storage code: every operation is `FileService` over whatever the app mounts.
- No change to the explorer's existing behaviour (see *Explorer extension*).

## Extension rule

Theia is extended, never patched: subclassing exported classes, implementing exported interfaces
and (re)binding exported DI symbols is fine, as long as only their **public or protected**
members are used — protected members being Theia's intended extension points. No private
members, no symbols a module does not export, no copies of Theia internals.

## Findings this rests on (Theia 1.76, this app)

- **All files are `file:` URIs** through the `FilesApi` provider; mounts are folders of a
  `CompositeFilesApi`, which already copies and moves **across mounts** (move = copy + remove,
  not atomic). `FileService.copy` / `move` therefore work between any two folders.
- **The explorer's drag payload** is two entries: `selected-tree-nodes` (node ids, meaningful
  only in its own tree model) and `theia-editor-dnd` (the URIs, newline-separated, via
  `ApplicationShell.setDraggedEditorUris`). A foreign widget can read the second. On drop, the
  explorer resolves only its own node ids; anything else falls through to
  `FileUploadService.upload` — so today a drop from a panel does nothing.
- The explorer's own drops never ask: Ctrl (⌥ on macOS) copies, a plain drop moves. Its node ids
  are `<root id>:<path>` and resolve only for nodes loaded in its model (expanded folders), so a
  foreign widget cannot reliably impersonate an explorer drag.
- `FileNavigatorWidget` is bound `toDynamicValue(createFileNavigatorWidget)` and its
  `WidgetFactory` calls `container.get(FileNavigatorWidget)`. `createFileNavigatorContainer`
  (exported from `@theia/navigator/lib/browser/navigator-container`) returns the child container
  in which the widget class is bound, so the widget class can be swapped inside Theia's own
  container without re-creating it.
- `handleDropEvent`, `getDropTargetDirNode` and `getDropEffect` are `protected` members of the
  exported `FileTreeWidget`.
- Theia's file dialog is already a **one-level `FileTreeWidget`** (root = current folder,
  folders do not expand) — the shape a panel needs.
- The editor breadcrumbs' popup is a file tree that *opens files*; a panel's dropdown must list
  *folders* and *navigate*, so only core's `BreadcrumbPopupContainer` (positioning, dismissal)
  is reusable.
- `WorkspaceCommands` (rename, delete, new file/folder, …) act on the selection published to
  `SelectionService`; a panel that publishes file-stat selections reuses them unchanged.
- The branch `feat/theia-shell-mount-roots` makes each mount a **workspace root**. Panels are
  therefore anchored on `WorkspaceService.tryGetRoots()`, not on `/`, and work the same before and
  after that lands. (It landed first; see *Mount-roots interplay* under Risks for what changed.)

## Architecture

New package **`packages/theia-file-panels`** (`@theia-shell/theia-file-panels`), a frontend-only
Theia extension depending on `@theia/core`, `@theia/filesystem`, `@theia/navigator`,
`@theia/workspace`. It knows nothing about mounts. The app adds it as a dependency and to its
build `--filter` list, like every other extension.

```
src/common/            pure, unit-tested, no DOM
  index.ts               re-exports every module below
  locale.ts              currentLocale(): nls.locale, "en" outside a browser
  format.ts              formatSize, formatDate, pluralCategory — all Intl-backed
  file-panels-nls.ts     every message key + English default; plural helper
  panel-sorting.ts       comparator: folders first, Intl.Collator, column + direction
  breadcrumb-model.ts    URI + workspace roots → segments; sibling selection
  transfer-planner.ts    sources + target + choices → steps; free names; clash resolution
  transfer-runner.ts     runs a plan's steps against injected copy/move; records failures, no rollback
src/browser/
  file-panel-widget.ts             one panel: header + tree, StatefulWidget; navigation, breadcrumb data
  file-panel-header.tsx            ReactWidget: column headers (ARIA table) with sort, status/retry, breadcrumb slot
  file-panel-tree.ts               FileTree/FileTreeModel subclasses: sorted listing, folder navigation
  file-panel-tree-widget.tsx       FileTreeWidget subclass: flat rows, size/modified cells, drag source/target
  folder-breadcrumb.tsx            segments, ▾ sibling popup, drop targets
  panel-drag.ts                    the theia-file-panels/uris marker: write on drag start, read on drop
  transfer-dialog.ts               AbstractDialog: copy / move / rename, name field, clash choice
  transfer-service.ts              runs a plan via FileService, with progress and failure report
  file-drop-handler.ts             one entry point for every drop into a panel
  panel-aware-navigator-widget.ts  FileNavigatorWidget subclass; the explorer's one new drop case
  file-panels-contribution.ts      commands, menus, widget factory
  file-panels-frontend-module.ts
  style/file-panels.css
```

| Unit | Responsibility | Depends on |
|---|---|---|
| `FilePanelWidget` | Holds the current folder URI; `navigateTo(uri)` swaps the tree root; composes the header and tree, renders the breadcrumb into the header; stores/restores state; on a vanished folder, falls back to the nearest existing ancestor. Title = folder label, tooltip = full path. | `FilePanelHeader`, `FilePanelTreeWidget`, `FolderBreadcrumb`, `WorkspaceService`, `LabelProvider` |
| `FilePanelHeader` | A `ReactWidget`: the column headings (name / size / modified) as an ARIA table (`role="table"` > `role="row"` > `role="columnheader"` with `aria-sort`, a `<button>` inside each), a status/retry line, and the breadcrumb the widget passes in. | `FilePanelWidget` |
| `FilePanelTree` / `FilePanelModel` | The one-level `FileTree`/`FileTreeModel`: children sorted by the active column; opening a folder navigates (`FilePanelModel.doOpenNode`) instead of expanding; opening a file uses Theia's open handler. | `FileTree`, `FileTreeModel`, `panel-sorting` |
| `FilePanelTreeWidget` | The `FileTreeWidget` subclass: folders never expand, renders the size/modified cells, publishes selection, writes `theia-editor-dnd` and the panel drag marker on drag start, delegates every drop to `FileDropHandler`. | `FileTreeWidget`, `FileDropHandler`, `panel-drag` |
| `FolderBreadcrumb` | Segments from `breadcrumb-model`; click navigates; ▾ opens the sibling list; each segment is a drop target. | `BreadcrumbPopupContainer`, `FileService` |
| `TransferPlanner` | Pure: decides steps, free names, skips. | none |
| `TransferDialog` | Collects the choice. | nls |
| `TransferService` | Executes steps; progress; aggregated failures; selects results. | `FileService`, `ProgressService`, `MessageService` |
| `FileDropHandler` | Reads a drop into a panel, validates, resolves, opens the dialog, runs the plan; routes OS files without a usable payload to upload. | the three above, `FileUploadService` |
| `PanelAwareNavigatorWidget` | Adds one case to the explorer's drop: a panel drag, handled by the explorer model's own copy/move. Every other drop goes to Theia's handler unchanged. | `FileNavigatorWidget`, `panel-drag` |

**Drag payload.** A panel drag carries the URIs twice: in `theia-editor-dnd` (so editors, the
shell and panels understand it, exactly as for an explorer drag) and in a panel-only marker type,
`theia-file-panels/uris`, by which the explorer recognises a panel drag.

**Two drop behaviours.** Into a panel: `FileDropHandler` and its dialog, whatever the source
(panel or explorer, both read from `theia-editor-dnd`). Into the explorer: Theia's rule, no
dialog — natively for explorer drags, through `PanelAwareNavigatorWidget` for panel drags.

## Panel

- **Listing.** Folders first, then files; sorted by the active column (name by default), with an
  `Intl.Collator(locale, { numeric: true, sensitivity: "base" })` for names (`file2` before
  `file10`). Size via `Intl.NumberFormat` with localized unit keys; modified via
  `Intl.DateTimeFormat`. Folders show no size. Clicking a column header sorts by it; clicking
  again reverses. The header is an ARIA table (`role="table"` > `role="row"` >
  `role="columnheader"` with `aria-sort`, each wrapping the sort `<button>`), not a literal
  `<table>` — the rows below stay Theia's own tree.
- **Keys inside the focused list** (tree-local, not keybindings): arrows move, Shift/Ctrl
  extend the selection, Enter opens (folder → navigate, file → open), Backspace goes up (while
  Theia's type-to-filter box is open, Backspace edits the filter instead). Opening a
  file goes through Theia's own open handler, exactly as the explorer does — the editor lands in
  the panel's tab group, over the panel (Theia's normal tab behaviour, not split beside it).
- **Toolbar**: Go Up, Refresh — each acts on the panel whose tab bar it sits on. Go Up (and
  Backspace) stops at a workspace root: above the mounts lies no workspace folder, only the hidden
  read-only composite `file:///`.
- **Starting folder**: the folder given to *Open in Files Panel*, else the first workspace root.
- **Freshness**: the tree refreshes on `fileService.onDidFilesChange` for its folder, which covers
  writes from the explorer, other panels and editors. If the current folder is deleted or
  renamed, the panel moves to the nearest existing ancestor within its workspace root (a removed
  mount: the first root) and shows a short localized notice in its status line. Refresh covers backends that emit no changes.

## Breadcrumb

- **Segments.** The first segment is the workspace root that contains the current folder,
  labelled through the `LabelProvider` (a mount shows its display name, not its key); then one
  segment per folder down to the current one. Clicking a segment navigates to it. When the path
  overflows, middle segments collapse into **…**, which opens a list of the hidden ones.
- **▾ Siblings.** Each segment has a ▾ that opens a popup listing its **sibling folders** —
  folders of its parent, read on open with `fileService.resolve(parent)` so never stale — sorted
  with the collator, the current one marked. For the first segment, the siblings are **the
  workspace roots** — one per mount ("Browser Storage", "Temporary", …). Choosing one navigates
  the panel.
  Arrows, Enter and Esc work in the list; click-outside and focus loss close it
  (`BreadcrumbPopupContainer`). The list is a small React component, not a tree.
- **Drop targets.** Dropping onto a segment targets that folder, exactly as a drop on a folder
  row. The segment stops its drag events, so the main area's own handlers (a `link` drop effect
  that cancels the drop; opening every dragged file in an editor) never see them.

## Drops and transfers

### `FileDropHandler`

1. Read URIs from `theia-editor-dnd`. If there are none but `dataTransfer.files` is non-empty,
   **upload** into the target with `FileUploadService` (no dialog) and stop. `FileUploadService`
   enumerates files through WebKit filesystem entries; a `DataTransfer` with none (as any
   script-built drop has) uploads nothing through that path, so the handler falls back to Theia's
   own exported `CustomDataTransfer`, built from `dataTransfer.files` directly, in that case. A
   genuine OS drag keeps the native `DataTransfer` path, folder support included. Either way, a
   single freshly uploaded file is auto-opened by Theia's own upload-complete handling — the same
   as for any single-file upload anywhere in the app, not something this package opts out of.
2. Target folder: the dropped-on folder (a row or a breadcrumb segment); a dropped-on file's
   parent; empty space → the panel's current folder.
3. **Reject** — localized warning, no dialog — a folder dropped into itself or its own descendant.
4. `fileService.resolveAll(sources)` for names and kinds; list the target's children for clashes.
5. Open `TransferDialog`; on OK, plan and run.

### `TransferDialog`

| Situation | Offered | Preselected |
|---|---|---|
| All sources already in the target, one item | **Copy** · **Rename** | Copy |
| All sources already in the target, several items | **Copy** only (each gets a free name) | Copy |
| Another folder, one or several items | **Copy** · **Move** | Move; Copy if Ctrl (⌥ on macOS) was held |

- **One item**: an editable **name** field — prefilled with the current name (Rename), a free
  name such as `notes copy.md` (same-folder Copy), or the source name (other folder). An existing
  name shows an inline "already exists — it will be replaced", and it is replaced — same-folder
  Copy included. Validated like Theia's rename: not
  empty, not `.` / `..`, no `/`. Rename with an unchanged name disables OK.
- **Several items with clashes**: one choice for all — **Overwrite**, **Keep both** (free names),
  **Skip** — with the count of clashing items.
- **Mixed selections** (some sources already in the target): the copy-or-rename restriction
  applies only when *all* sources are in the target; otherwise, under Move those already there
  are skipped, under Copy they get free names.
- Enter confirms, Esc cancels. Title and labels are localized with plural forms.

### `TransferPlanner` (pure)

Input: sources `{ uri, name, isDirectory }[]`, target folder, the target's existing names, the
operation (`copy | move | rename`), an optional single name, a clash policy
(`overwrite | keepBoth | skip`), and a `freeName(base, n)` function supplied by the caller (so the
suffix is localized). Output: ordered steps `{ op: "copy" | "move", from, to, overwrite }` and
the skipped sources with a reason.

- Free names insert the suffix before the **first** extension dot (`a.tar.gz` → `a copy.tar.gz`);
  dotfiles and folders take it at the end (`.env copy`); repeats count on (`copy 2`, `copy 3`).
- Clashes **between sources** (two `README.md` from different folders) are resolved like clashes
  with the target.
- A step whose source equals its destination is dropped.

### `TransferService`

- Runs steps in order through `fileService.copy` / `fileService.move` with each step's
  `overwrite` — the same calls the explorer makes, so change events reach every view.
- Progress through `ProgressService`; cancellable between steps (no rollback).
- A failing step does not stop the batch; one notification at the end: "{0} of {1} items failed"
  (plural on the total, counts through `Intl.NumberFormat`) and one "{0}: {1}" line (name, reason)
  per failure.
- A drop or transfer that fails as a whole (resolving the sources, an upload, a refresh) is
  handled in one place: logged and shown as one localized error; a cancellation is silent. No
  drop path leaves a rejected promise unhandled.
- A cross-mount move is copy-then-remove inside the composite and not atomic: after a partial
  failure a copy may exist while the original remains. Stated, not hidden.
- On completion the new items are selected in the target panel.

## Explorer extension

The explorer's existing behaviour does not change; it gains one case — accepting a panel drag.

- `PanelAwareNavigatorWidget extends FileNavigatorWidget` and overrides the protected
  `handleDropEvent(node, event)`:
  - **no `theia-file-panels/uris` in the drop** → `super.handleDropEvent(node, event)`, untouched:
    explorer→explorer drags, OS-file uploads and everything else behave exactly as today;
  - **a panel drag** → the target is the inherited `getDropTargetDirNode(node)`, the operation the
    inherited `getDropEffect(event)` (Ctrl/⌥ → copy, else move), with **no dialog**. Each URI goes
    through the explorer model's own **public** methods, exactly as an explorer drag does:
    `model.copy(uri, target)`, and `model.move(sourceNode, target)` with a detached
    `FileStatNode` built from the resolved `FileStat` (a public interface). So clashes behave as
    Theia's: a move asks Theia's replace confirmation, a copy takes a free name, a move onto the
    source's own folder is a no-op. `FileDropHandler` and `TransferService` are not involved.
- Binding: the module rebinds `FileNavigatorWidget` to
  `toDynamicValue(ctx => { const child = createFileNavigatorContainer(ctx.container);
  child.rebind(FileNavigatorWidget).to(PanelAwareNavigatorWidget); return child.get(FileNavigatorWidget); })`.
  Theia's own container is used as is — tree, model, decorators, props and toolbar remain Theia's.

Other standard file trees (the file dialog, the breadcrumb popup) are not extended; a panel drag
onto them does nothing, as today.

## Commands and menus

All labels localized; **no keybindings**.

| Command | Where |
|---|---|
| Open Files Panel | View menu; command palette. Opens at the first workspace root. |
| Open in Files Panel | Explorer context menu on a folder (or a file → its folder). |
| Copy to Other Panel… / Move to Other Panel… | Panel context menu; enabled when another panel exists; with several others, a quick pick chooses one. Target = that panel's current folder; opens `TransferDialog` preset to the choice. |
| Go Up, Refresh | Panel toolbar. |
| Open, Open With…, New File, New Folder, Rename, Delete, Copy Path, Reveal in Explorer | Panel context menu, reusing Theia's `WorkspaceCommands` / navigator commands through the published selection — their dialogs, confirmations and localization included. |

The panel context menu has its own menu path (`FILE_PANEL_CONTEXT_MENU`), so it does not depend on
the explorer's menu layout.

## Persistence and errors

- `FilePanelWidget` is a `StatefulWidget` created by its `WidgetFactory` with a unique `{ id }`,
  so Theia's layout restore reopens every panel. Stored: folder URI, sort column and direction.
- On restore, a folder that does not exist (`FILE_NOT_FOUND`) falls back to its nearest existing
  ancestor within its workspace root, then to the first workspace root, with a notice. The same holds for the folder a panel
  was created at (*Open in Files Panel*), which Theia re-creates the panel with before restoring
  its state: creating a panel never fails. A folder that exists but cannot be read (vault locked,
  local folder awaiting permission — any other error) stays: **Not available** with **Retry** —
  the panel is not closed, so the layout survives an unlock.
- A navigation never throws. A folder that cannot be resolved still becomes the panel's folder —
  breadcrumb, Go Up and the stored state keep it — with an empty list and "“{0}” is not
  available: {1}" with **Retry**, which navigates to that same folder again.
- A listing failure shows in the panel with Retry, not as a toast. Transfer failures are
  aggregated (above). Reused commands keep Theia's error handling. All messages are localized.

## Internationalization

- Every user-visible string goes through
  `nls.localize("theia-shell/file-panels/<key>", "<English default>")`. Keys and defaults live in
  one module, `common/file-panels-nls.ts`; no message is concatenated; placeholders are `{0}`.
- Plurals: `Intl.PluralRules(locale)` selects the key (`copyItems.one` / `copyItems.other`),
  never "item(s)".
- Locale: `nls.locale ?? "en"` for `Intl.NumberFormat`, `Intl.DateTimeFormat`, `Intl.Collator`,
  `Intl.PluralRules`.
- Free-name suffixes (" copy", " copy {0}") are localized and injected into the planner.
- RTL: CSS logical properties (`margin-inline-start`, `text-align: start`); breadcrumb separator
  and ▾ are CSS-drawn and mirror under `dir="rtl"`.
- Theia's own reused commands and dialogs are already localized by Theia.

## Testing (red → green, as in PLAN.md)

**Unit (vitest, no Theia DOM)**

- `TransferPlanner`: same-folder rules (one → copy/rename; several → copy only); free names
  (extensions, multi-dot, dotfiles, folders, counting on); overwrite / keep both / skip;
  clashes between sources; mixed selections; source = destination dropped; a non-English suffix.
- Drop validation: folder into itself / descendant rejected.
- `panel-sorting`: folders first; numeric order; accented names under a `de` collator; direction;
  size and date columns.
- `breadcrumb-model`: segments from a URI and workspace roots (single and multi-root); siblings
  of the first segment are the other roots; Go Up stops at a root; a vanished folder falls back
  only within its root.
- `file-panels-nls`: keys unique; every entry's placeholders consistent; plural pairs complete.

**E2E (Playwright, static build, seeded files)**

1. View → Open Files Panel; open a folder; return via the breadcrumb.
2. A breadcrumb ▾ jumps to a sibling folder.
3. From a panel: open a file, rename it, delete it — the explorer reflects each step.
4. Two panels side by side: drag a file across, choose Copy — both folders hold it.
5. Same with Move — the source no longer has it.
6. Drop into the same folder: only Copy and Rename offered; Copy creates `… copy.ext`.
7. Explorer → panel shows the dialog. Panel → explorer shows **no** dialog: a plain drop moves,
   Ctrl copies. Explorer → explorer still moves without a dialog (unchanged behaviour).
8. Several items with a clash: Keep both, Skip, Overwrite each behave (one test per choice).
9. An OS file dropped into a panel is uploaded (synthetic `DataTransfer` with a `File`).
10. Reload: panels return at their folders with their sort.
11. Copy to Other Panel… from the context menu; the copy is selected in the target panel.
12. A drop on a breadcrumb segment of another panel copies there and opens no editor.
13. A folder that cannot be read shows Not available; Retry opens it once it can. A panel whose
    creation folder is gone after a reload comes back at its parent.
14. Backspace inside the type-to-filter box does not go up; the toolbar's Go Up acts on its panel
    while the focus is elsewhere; hovering a folder row during a drag leaves the selection.
15. Mounts as roots: a panel opens in the main storage; the first segment's ▾ lists the mounts
    and moves the panel to one; Move to Other Panel moves across mounts; Go Up and Backspace stop
    at a root; a panel on a removed mount falls back to the first root; a copy into an
    unreachable (read-only) mount is reported as failed.

Red and green runs are recorded, as in earlier work.

## Risks

- **Protected extension points.** The explorer extension overrides the protected
  `handleDropEvent` and calls the protected `getDropTargetDirNode` / `getDropEffect`; a Theia
  upgrade that renames or re-signs them breaks panel→explorer drops. E2E 7 catches it, and the
  override falls through to `super` for every drop that is not a panel drag, so the explorer's own
  behaviour cannot regress through it.
- **Columns over a tree.** `FileTreeWidget` rows are not a table; the header and grid rows need
  careful CSS (widths, RTL, virtualized scrolling). Kept in one stylesheet and covered by e2e.
- **Non-atomic cross-mount moves** (above).
- **Mount-roots interplay.** Anchoring on workspace roots keeps panels correct whether or not
  `feat/theia-shell-mount-roots` lands first; whichever lands second re-runs the other's e2e.
  Mount-roots landed first. Re-running this e2e on it found two places that still reached above
  the roots — Go Up and the vanished-folder fallback walked to `file:///`, which is no longer a
  workspace folder — now both stop at the containing root. The e2e start inside the main storage;
  the transfer-failure test targets an unreachable mount (a read-only placeholder) instead of the
  former read-only "Files" root.
- **No visible translation** until the app gets a translation provider (separate issue).

## Decisions made while planning

1. Clashes between dropped sources never overwrite: under *Overwrite* the later source gets a free
   name; *Skip* skips it; *Keep both* gives it a free name.
2. Plural messages have one literal key per CLDR category; the English default of every category
   other than `one` is the `other` text.
3. Size units are formatted by `Intl.NumberFormat` (`style: "unit"`), not by message keys.
4. Go Up and Refresh are tab-bar toolbar items of the active panel.
5. The panel's "Open" is its own command; the other context-menu entries are Theia's commands on
   the global selection.
6. A new panel opens split to the right of the current panel, else as a main-area tab.
7. Drop handlers read the `DataTransfer` synchronously, before their first `await`.
