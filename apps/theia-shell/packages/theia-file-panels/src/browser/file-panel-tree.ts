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

/** What one navigation came to: the folder listed, a failure and why, or a newer navigation won. */
export type NavigationOutcome =
  | { kind: "shown" }
  | { kind: "failed"; error: Error }
  | { kind: "superseded" };

/** Opening a folder navigates the panel into it; opening a file opens it like the explorer does. */
@injectable()
export class FilePanelModel extends FileTreeModel {
  @inject(OpenerService) protected readonly openerService!: OpenerService;
  protected readonly onDidNavigateEmitter = new Emitter<URI>();
  /** Fired when the panel stands at a new folder — listed, or failed to open (see `failure`). */
  readonly onDidNavigate = this.onDidNavigateEmitter.event;
  /** Bumped by every navigation, so a slower, older listing never replaces a newer one. */
  protected navigations = 0;
  /** The folder the panel stands at: listed, or — while `failure` is set — failed to open. */
  folder: URI | undefined;
  /** Why `folder` could not be opened; undefined while it is listed. */
  failure: Error | undefined;

  /**
   * Never throws. A folder that cannot be resolved still becomes the panel's `folder` (so it is
   * stored, and Retry and Go Up start from it); the list is emptied and `failure` says why.
   */
  async navigateToFolder(uri: URI): Promise<NavigationOutcome> {
    const ticket = ++this.navigations;
    let outcome: NavigationOutcome;
    try {
      const stat = await this.fileService.resolve(uri);
      if (ticket !== this.navigations) return { kind: "superseded" };
      await this.navigateTo({ ...DirNode.createRoot(stat), visible: false });
      outcome = { kind: "shown" };
    } catch (error) {
      outcome = {
        kind: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    if (ticket !== this.navigations) return { kind: "superseded" };
    this.folder = uri;
    this.failure = outcome.kind === "failed" ? outcome.error : undefined;
    if (this.failure) this.root = undefined;
    this.onDidNavigateEmitter.fire(uri);
    return outcome;
  }

  protected override doOpenNode(node: TreeNode): void {
    if (DirNode.is(node)) void this.navigateToFolder(node.uri);
    else if (FileNode.is(node)) void open(this.openerService, node.uri);
    else super.doOpenNode(node);
  }
}
