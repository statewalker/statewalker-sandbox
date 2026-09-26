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
