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
