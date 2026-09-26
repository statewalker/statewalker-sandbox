import { ContextMenuRenderer } from "@theia/core/lib/browser/context-menu-renderer";
import type { TreeNode } from "@theia/core/lib/browser/tree/tree";
import { TreeModel } from "@theia/core/lib/browser/tree/tree-model";
import { type NodeProps, TreeProps } from "@theia/core/lib/browser/tree/tree-widget";
import { Emitter } from "@theia/core/lib/common/event";
import { Key } from "@theia/core/lib/common/keys";
import { inject, injectable } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { FileStatNode, FileTreeWidget } from "@theia/filesystem/lib/browser/file-tree";
import { formatDate, formatSize } from "../common/format";
import type { FilePanelModel } from "./file-panel-tree";

@injectable()
export class FilePanelTreeWidget extends FileTreeWidget {
  readonly onGoUp = new Emitter<void>();

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) override readonly model: FilePanelModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer,
  ) {
    super(props, model, contextMenuRenderer);
    this.addClass("file-panel-tree");
    this.toDispose.push(this.onGoUp);
  }

  protected override init(): void {
    super.init();
    this.addKeyListener(this.node, Key.BACKSPACE, () => this.onGoUp.fire());
  }

  /** Folders never expand: opening one navigates (FilePanelModel.doOpenNode). */
  protected override renderExpansionToggle(_node: TreeNode, _props: NodeProps): React.ReactNode {
    return null;
  }

  protected override async handleRight(_event: KeyboardEvent): Promise<void> {}

  protected override getPaddingLeft(_node: TreeNode, _props: NodeProps): number {
    return 4;
  }

  protected override renderTailDecorations(node: TreeNode, props: NodeProps): React.ReactNode {
    const decorations = super.renderTailDecorations(node, props);
    if (!FileStatNode.is(node)) return decorations;
    const { fileStat } = node;
    return (
      <>
        {decorations}
        <span className="file-panel-cell file-panel-size">
          {fileStat.isDirectory || fileStat.size === undefined ? "" : formatSize(fileStat.size)}
        </span>
        <span className="file-panel-cell file-panel-modified">
          {fileStat.mtime ? formatDate(fileStat.mtime) : ""}
        </span>
      </>
    );
  }
}
