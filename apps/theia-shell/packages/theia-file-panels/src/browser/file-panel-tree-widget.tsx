import { ContextMenuRenderer } from "@theia/core/lib/browser/context-menu-renderer";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import type { TreeNode } from "@theia/core/lib/browser/tree/tree";
import { TreeModel } from "@theia/core/lib/browser/tree/tree-model";
import { type NodeProps, TreeProps } from "@theia/core/lib/browser/tree/tree-widget";
import { isCancelled } from "@theia/core/lib/common/cancellation";
import { Emitter } from "@theia/core/lib/common/event";
import { Key } from "@theia/core/lib/common/keys";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { FileStatNode, FileTreeWidget } from "@theia/filesystem/lib/browser/file-tree";
import { formatDate, formatSize } from "../common/format";
import { FileDropHandler } from "./file-drop-handler";
import type { FilePanelModel } from "./file-panel-tree";
import { writePanelDrag } from "./panel-drag";

@injectable()
export class FilePanelTreeWidget extends FileTreeWidget {
  readonly onGoUp = new Emitter<void>();
  /** Fired with the URIs a drop wrote, so the panel can select them. */
  readonly onDidDrop = new Emitter<URI[]>();

  @inject(FileDropHandler) protected readonly drops!: FileDropHandler;

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) override readonly model: FilePanelModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer,
  ) {
    super(props, model, contextMenuRenderer);
    this.addClass("file-panel-tree");
    this.toDispose.push(this.onGoUp);
    this.toDispose.push(this.onDidDrop);
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

  protected override handleDragStartEvent(node: TreeNode, event: React.DragEvent): void {
    super.handleDragStartEvent(node, event);
    const uris = ApplicationShell.getDraggedEditorUris(event.dataTransfer);
    writePanelDrag(event.dataTransfer, uris);
    event.dataTransfer.effectAllowed = "copyMove";
  }

  /** No auto-expansion while hovering a folder: the list is flat. */
  protected override handleDragOverEvent(
    _node: TreeNode | undefined,
    event: React.DragEvent,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = this.getDropEffect(event);
  }

  protected override async handleDropEvent(
    node: TreeNode | undefined,
    event: React.DragEvent,
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const target = this.getDropTargetDirNode(node)?.uri ?? this.model.location;
    if (!target) return;
    try {
      const written = await this.drops.drop(
        target,
        event.dataTransfer,
        this.getDropEffect(event) === "copy",
      );
      if (written.length > 0) this.onDidDrop.fire(written);
    } catch (error) {
      if (!isCancelled(error as Error)) this.logger.error(error);
    }
  }

  /** A drop on a breadcrumb segment: the same path as a drop on a folder row. */
  async dropOnFolder(target: URI, event: React.DragEvent): Promise<void> {
    const written = await this.drops.drop(
      target,
      event.dataTransfer,
      this.getDropEffect(event) === "copy",
    );
    if (written.length > 0) this.onDidDrop.fire(written);
  }
}
