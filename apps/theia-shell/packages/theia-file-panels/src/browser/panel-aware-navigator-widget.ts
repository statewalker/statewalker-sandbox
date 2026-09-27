import { ContextMenuRenderer } from "@theia/core/lib/browser/context-menu-renderer";
import type { TreeNode } from "@theia/core/lib/browser/tree/tree";
import { TreeModel } from "@theia/core/lib/browser/tree/tree-model";
import { TreeProps } from "@theia/core/lib/browser/tree/tree-widget";
import { isCancelled } from "@theia/core/lib/common/cancellation";
import { inject, injectable } from "@theia/core/shared/inversify";
import type * as React from "@theia/core/shared/react";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import type { FileStatNode } from "@theia/filesystem/lib/browser/file-tree";
import type { FileNavigatorModel } from "@theia/navigator/lib/browser/navigator-model";
import { FileNavigatorWidget } from "@theia/navigator/lib/browser/navigator-widget";
import { readPanelDrag } from "./panel-drag";

/**
 * The explorer, plus one case: a drag from a file panel is copied or moved with the explorer's
 * own rule (Ctrl/⌥ copies) through its model's public copy/move — no dialog. Every other drop
 * goes to Theia's handler untouched.
 */
@injectable()
export class PanelAwareNavigatorWidget extends FileNavigatorWidget {
  @inject(FileService) protected readonly files!: FileService;

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) model: FileNavigatorModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer,
  ) {
    super(props, model, contextMenuRenderer);
  }

  protected override async handleDropEvent(
    node: TreeNode | undefined,
    event: React.DragEvent,
  ): Promise<void> {
    const uris = readPanelDrag(event.dataTransfer);
    if (uris.length === 0) return super.handleDropEvent(node, event);
    event.preventDefault();
    event.stopPropagation();
    const effect = this.getDropEffect(event);
    event.dataTransfer.dropEffect = effect;
    const target = this.getDropTargetDirNode(node);
    if (!target) return;
    for (const uri of uris) {
      try {
        if (effect === "copy") {
          await this.model.copy(uri, target);
        } else {
          const stat = await this.files.resolve(uri);
          const source: FileStatNode = {
            id: stat.resource.toString(),
            name: stat.name,
            uri: stat.resource,
            fileStat: stat,
            parent: undefined,
            selected: false,
          } as FileStatNode;
          await this.model.move(source, target);
        }
      } catch (error) {
        if (!isCancelled(error as Error)) this.logger.error(error);
      }
    }
  }
}
