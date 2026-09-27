import { ContextMenuRenderer } from "@theia/core/lib/browser/context-menu-renderer";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import type { TreeNode } from "@theia/core/lib/browser/tree/tree";
import { TreeModel } from "@theia/core/lib/browser/tree/tree-model";
import { type NodeProps, TreeProps } from "@theia/core/lib/browser/tree/tree-widget";
import type { Message } from "@theia/core/lib/browser/widgets/widget";
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
import { TransferService } from "./transfer-service";

@injectable()
export class FilePanelTreeWidget extends FileTreeWidget {
  readonly onGoUp = new Emitter<void>();
  /** Fired with the URIs a drop wrote, so the panel can select them. */
  readonly onDidDrop = new Emitter<URI[]>();

  @inject(FileDropHandler) protected readonly drops!: FileDropHandler;
  @inject(TransferService) protected readonly transfers!: TransferService;

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

  /**
   * Backspace goes up — unless the type-to-filter box is open, where it edits the filter. Added
   * before `super.onAfterAttach` registers the search box's own key listener, so this one sees
   * the box still open on the Backspace that empties and closes it. Re-added on every attach:
   * `addKeyListener` listeners are disposed on detach.
   */
  protected override onAfterAttach(msg: Message): void {
    this.addKeyListener(this.node, Key.BACKSPACE, () => {
      if (!this.searchBox?.isVisible) this.onGoUp.fire();
    });
    super.onAfterAttach(msg);
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

  /** Hovering a folder during a drag leaves the selection alone (the inherited one selects it). */
  protected override handleDragEnterEvent(
    _node: TreeNode | undefined,
    event: React.DragEvent,
  ): void {
    event.preventDefault();
    event.stopPropagation();
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
    if (target) await this.dropOnFolder(target, event);
  }

  /** A drag over a breadcrumb segment: the same as over a row. */
  dragOverFolder(event: React.DragEvent): void {
    this.handleDragOverEvent(undefined, event);
  }

  /**
   * A drop on `target` — a row's folder, the panel's folder or a breadcrumb segment. Reads the
   * payload before its first `await`; a failure is reported, never left unhandled.
   */
  async dropOnFolder(target: URI, event: React.DragEvent): Promise<void> {
    try {
      const written = await this.drops.drop(
        target,
        event.dataTransfer,
        this.getDropEffect(event) === "copy",
      );
      if (written.length > 0) this.onDidDrop.fire(written);
    } catch (error) {
      this.transfers.reportError(error);
    }
  }
}
