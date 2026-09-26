import { OpenerService, open } from "@theia/core/lib/browser/opener-service";
import type { CompositeTreeNode, TreeNode } from "@theia/core/lib/browser/tree/tree";
import { Emitter } from "@theia/core/lib/common/event";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import {
  DirNode,
  FileNode,
  type FileStatNode,
  FileTree,
  FileTreeModel,
} from "@theia/filesystem/lib/browser/file-tree";
import type { FileStat } from "@theia/filesystem/lib/common/files";
import { compareEntries, DEFAULT_SORT, type SortState } from "../common/panel-sorting";

/** One folder, flat: children carry size and date, and are sorted by the panel's sort. */
@injectable()
export class FilePanelTree extends FileTree {
  sort: SortState = DEFAULT_SORT;
  listingError: string | undefined;
  protected readonly onDidChangeListingErrorEmitter = new Emitter<void>();
  readonly onDidChangeListingError = this.onDidChangeListingErrorEmitter.event;

  protected override async resolveFileStat(node: FileStatNode): Promise<FileStat | undefined> {
    try {
      const stat = await this.fileService.resolve(node.uri, { resolveMetadata: true });
      node.fileStat = stat;
      this.setListingError(undefined);
      return stat;
    } catch (error) {
      this.setListingError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  protected override async toNodes(
    fileStat: FileStat,
    parent: CompositeTreeNode,
  ): Promise<TreeNode[]> {
    const nodes = await super.toNodes(fileStat, parent);
    const compare = compareEntries(this.sort);
    const entry = (node: TreeNode) => {
      const stat = (node as FileStatNode).fileStat;
      return { name: stat.name, isDirectory: stat.isDirectory, size: stat.size, mtime: stat.mtime };
    };
    return nodes.sort((a, b) => compare(entry(a), entry(b)));
  }

  protected setListingError(message: string | undefined): void {
    if (message === this.listingError) return;
    this.listingError = message;
    this.onDidChangeListingErrorEmitter.fire();
  }
}

/** Opening a folder navigates the panel into it; opening a file opens it like the explorer does. */
@injectable()
export class FilePanelModel extends FileTreeModel {
  @inject(OpenerService) protected readonly openerService!: OpenerService;
  protected readonly onDidNavigateEmitter = new Emitter<URI>();
  readonly onDidNavigate = this.onDidNavigateEmitter.event;
  /** Bumped by every navigation, so a slower, older listing never replaces a newer one. */
  protected navigations = 0;

  async navigateToFolder(uri: URI): Promise<void> {
    const ticket = ++this.navigations;
    const stat = await this.fileService.resolve(uri);
    if (ticket !== this.navigations) return;
    await this.navigateTo({ ...DirNode.createRoot(stat), visible: false });
    this.onDidNavigateEmitter.fire(uri);
  }

  protected override doOpenNode(node: TreeNode): void {
    if (DirNode.is(node)) void this.navigateToFolder(node.uri);
    else if (FileNode.is(node)) void open(this.openerService, node.uri);
    else super.doOpenNode(node);
  }
}
