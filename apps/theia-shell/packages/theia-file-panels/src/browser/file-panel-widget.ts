import {
  type BreadcrumbPopupContainer,
  BreadcrumbPopupContainerFactory,
} from "@theia/core/lib/browser/breadcrumbs/breadcrumb-popup-container";
import { LabelProvider } from "@theia/core/lib/browser/label-provider";
import type { StatefulWidget } from "@theia/core/lib/browser/shell/shell-layout-restorer";
import { SelectableTreeNode } from "@theia/core/lib/browser/tree/tree-selection";
import { BaseWidget, type Message } from "@theia/core/lib/browser/widgets/widget";
import { Disposable } from "@theia/core/lib/common/disposable";
import URI from "@theia/core/lib/common/uri";
import { PanelLayout, type Widget } from "@theia/core/shared/@lumino/widgets";
import { inject, injectable, type interfaces } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { createRoot } from "@theia/core/shared/react-dom/client";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { createFileTreeContainer } from "@theia/filesystem/lib/browser/file-tree";
import { FileOperationError, FileOperationResult } from "@theia/filesystem/lib/common/files";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import {
  type Crumb,
  fallbackAncestors,
  parentWithin,
  siblingSource,
} from "../common/breadcrumb-model";
import { Messages } from "../common/file-panels-nls";
import { compareEntries, type SortState, toggleSort } from "../common/panel-sorting";
import { FilePanelHeader, type FilePanelHeaderState } from "./file-panel-header";
import { FilePanelModel, FilePanelTree, type NavigationOutcome } from "./file-panel-tree";
import { FilePanelTreeWidget } from "./file-panel-tree-widget";
import { FolderBreadcrumb, FolderList } from "./folder-breadcrumb";
import { TransferService } from "./transfer-service";

export const FILE_PANEL_CONTEXT_MENU = ["file-panel-context-menu"];

export const FilePanelOptions = Symbol("FilePanelOptions");
export interface FilePanelOptions {
  id: string;
  folder?: string;
}

/** A folder that does not exist — as opposed to one that exists but cannot be read now. */
function isNotFound(error: Error): boolean {
  return (
    error instanceof FileOperationError &&
    error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND
  );
}

/** One file panel: header (breadcrumb, column headings, status) over a flat file tree. */
@injectable()
export class FilePanelWidget extends BaseWidget implements StatefulWidget {
  static readonly FACTORY_ID = "file-panel";

  @inject(FilePanelOptions) protected readonly options!: FilePanelOptions;
  @inject(FilePanelTreeWidget) readonly tree!: FilePanelTreeWidget;
  @inject(FilePanelTree) protected readonly fileTree!: FilePanelTree;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(LabelProvider) protected readonly labels!: LabelProvider;
  @inject(BreadcrumbPopupContainerFactory)
  protected readonly popups!: BreadcrumbPopupContainerFactory;
  @inject(FileService) protected readonly files!: FileService;
  @inject(TransferService) protected readonly transfers!: TransferService;

  protected header!: FilePanelHeader;
  /** The open sibling / hidden-folder popup, if any. */
  protected popup: BreadcrumbPopupContainer | undefined;

  /** A notice shown until the next navigation (a folder that disappeared). */
  protected notice: string | undefined;

  get model(): FilePanelModel {
    return this.tree.model;
  }

  /** The panel's folder — also while it cannot be read (then the header says why). */
  get folder(): URI | undefined {
    return this.model.folder;
  }

  get sort(): SortState {
    return this.fileTree.sort;
  }

  async initialize(): Promise<void> {
    this.id = this.options.id;
    this.title.closable = true;
    this.title.iconClass = "codicon codicon-folder";
    this.addClass("file-panel");
    this.header = new FilePanelHeader({ sort: this.sort }, (column) =>
      this.setSort(toggleSort(this.sort, column)),
    );
    const layout = new PanelLayout();
    layout.addWidget(this.header);
    layout.addWidget(this.tree);
    this.layout = layout;

    this.toDispose.pushAll([
      this.header,
      this.tree,
      this.tree.onGoUp.event(() => void this.goUp()),
      this.model.onDidNavigate((uri) => this.onNavigated(uri)),
      this.model.onChanged(() => this.updateEmptyState()),
      this.fileTree.onDidChangeListingError(() => this.updateEmptyState()),
      this.workspace.onWorkspaceChanged(() => this.renderBreadcrumb()),
      this.tree.onDidDrop.event((uris) => void this.selectWritten(uris)),
      Disposable.create(() => this.popup?.dispose()),
      this.files.onDidFilesChange((event) => {
        const folder = this.folder;
        if (folder && event.changes.some((change) => change.resource.isEqualOrParent(folder))) {
          void this.files
            .exists(folder)
            .catch(() => false)
            .then((exists) => {
              if (!exists && this.folder?.isEqual(folder)) void this.navigateToExisting(folder);
            });
        }
      }),
    ]);
    // Never throws: a creation folder that is gone falls back like a restored one, so Theia's
    // layout restore never drops the panel.
    const start = this.options.folder ? new URI(this.options.folder) : await this.defaultFolder();
    await this.navigateToExisting(start);
  }

  storeState(): object {
    return { folder: this.folder?.toString(), sort: this.sort };
  }

  restoreState(state: { folder?: string; sort?: SortState }): void {
    if (state.sort) this.setSort(state.sort);
    if (state.folder) void this.navigateToExisting(new URI(state.folder));
  }

  /**
   * `uri`; if it does not exist, its nearest existing ancestor within its workspace root, else
   * the first workspace root, with a notice. A folder that exists but cannot be read (a locked
   * mount) stays, shown as not available with Retry. Never throws.
   */
  protected async navigateToExisting(uri: URI): Promise<void> {
    const outcome = await this.navigateTo(uri);
    if (outcome.kind !== "failed" || !isNotFound(outcome.error)) return;
    // The roots may still be loading while the layout is restored: wait for them.
    const roots = (await this.workspace.roots).map((root) => root.resource);
    for (const candidate of fallbackAncestors(uri, roots)) {
      if (await this.files.exists(candidate).catch(() => false)) {
        return this.showInstead(uri, candidate);
      }
    }
    await this.showInstead(uri, await this.defaultFolder());
  }

  protected async showInstead(gone: URI, shown: URI): Promise<void> {
    if ((await this.navigateTo(shown)).kind !== "shown") return;
    this.notice = Messages.folderGone(gone.path.base, this.labels.getName(shown));
    this.updateEmptyState();
  }

  /** Never throws; see `FilePanelModel.navigateToFolder`. */
  navigateTo(uri: URI): Promise<NavigationOutcome> {
    this.notice = undefined;
    return this.model.navigateToFolder(uri);
  }

  /** The folder Go Up leads to; none at a workspace root. */
  get upFolder(): URI | undefined {
    return this.folder && parentWithin(this.folder, this.roots());
  }

  async goUp(): Promise<void> {
    const up = this.upFolder;
    if (up) await this.navigateTo(up);
  }

  /** Re-reads the folder; one that could not be opened is tried again. */
  async refresh(): Promise<void> {
    if (this.model.failure && this.folder) await this.navigateTo(this.folder);
    else await this.model.refresh();
  }

  /** Selects what a drop or transfer wrote into this panel's folder. */
  async selectWritten(uris: URI[]): Promise<void> {
    try {
      await this.model.refresh();
      const nodes = uris
        .filter((uri) => this.folder && uri.parent.isEqual(this.folder))
        .map((uri) => this.model.getNode(uri.path.toString()))
        .filter((node): node is SelectableTreeNode => SelectableTreeNode.is(node));
      nodes.forEach((node, i) => {
        if (i === 0) this.model.selectNode(node);
        else this.model.addSelection(node);
      });
    } catch (error) {
      this.transfers.reportError(error);
    }
  }

  setSort(state: SortState): void {
    this.fileTree.sort = state;
    this.header.setState({ sort: state });
    void this.model.refresh();
  }

  protected async defaultFolder(): Promise<URI> {
    const [first] = await this.workspace.roots;
    return first ? first.resource : new URI("file:///");
  }

  protected onNavigated(uri: URI): void {
    this.title.label = this.labels.getName(uri);
    this.title.caption = this.labels.getLongName(uri);
    this.updateEmptyState();
    this.renderBreadcrumb();
  }

  protected roots(): URI[] {
    return this.workspace.tryGetRoots().map((root) => root.resource);
  }

  protected renderBreadcrumb(): void {
    const current = this.folder;
    if (!current) return;
    this.header.setState({
      breadcrumb: React.createElement(FolderBreadcrumb, {
        current,
        roots: this.roots(),
        labels: this.labels,
        navigate: (uri) => void this.navigateTo(uri),
        openSiblings: (crumb, anchor) => void this.openSiblings(crumb, anchor),
        openHidden: (hidden, anchor) =>
          this.showFolderList(
            hidden.map((c) => ({ uri: c.uri, name: this.labels.getName(c.uri) })),
            undefined,
            anchor,
          ),
        onDragOverCrumb: (event) => this.tree.dragOverFolder(event),
        onDropOnCrumb: (uri, event) => void this.tree.dropOnFolder(uri, event),
      }),
    });
  }

  async openSiblings(crumb: Crumb, anchor: HTMLElement): Promise<void> {
    const source = siblingSource(crumb, this.roots());
    if (!source) return;
    let uris: URI[];
    if (source.kind === "roots") {
      uris = source.roots;
    } else {
      const parent = await this.files.resolve(source.parent);
      uris = (parent.children ?? []).filter((c) => c.isDirectory).map((c) => c.resource);
    }
    const compare = compareEntries({ column: "name", direction: "asc" });
    const folders = uris
      .map((uri) => ({ uri, name: this.labels.getName(uri) }))
      .sort((a, b) =>
        compare({ name: a.name, isDirectory: true }, { name: b.name, isDirectory: true }),
      );
    this.showFolderList(folders, crumb.uri, anchor);
  }

  protected showFolderList(
    folders: { uri: URI; name: string }[],
    current: URI | undefined,
    anchor: HTMLElement,
  ): void {
    this.popup?.dispose();
    const box = anchor.getBoundingClientRect();
    const popup = this.popups(this.node, `file-panel-siblings:${this.id}`, {
      x: box.left,
      y: box.bottom,
    });
    this.popup = popup;
    const root = createRoot(popup.container);
    popup.onDidDispose(() => {
      root.unmount();
      if (this.popup === popup) this.popup = undefined;
    });
    root.render(
      React.createElement(FolderList, {
        folders,
        current,
        choose: (uri) => {
          popup.dispose();
          void this.navigateTo(uri);
        },
      }),
    );
  }

  protected updateEmptyState(): void {
    this.header.setState({ status: this.status() });
  }

  /** The status line: a folder that could not be opened, a failed listing, a notice, or empty. */
  protected status(): FilePanelHeaderState["status"] {
    const { failure } = this.model;
    const folder = this.folder;
    if (failure && folder) {
      return {
        text: Messages.notAvailable(this.labels.getName(folder), failure.message),
        retry: () => void this.navigateTo(folder),
      };
    }
    const error = this.fileTree.listingError;
    if (error) {
      return {
        text: Messages.notAvailable(this.title.label, error),
        retry: () => void this.refresh(),
      };
    }
    if (this.notice) return { text: this.notice };
    const root = this.model.root;
    const empty = root && "children" in root && (root.children as unknown[]).length === 0;
    return empty ? { text: Messages.emptyFolder() } : undefined;
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.tree.activate();
  }

  protected override onResize(msg: Widget.ResizeMessage): void {
    super.onResize(msg);
    this.tree.update();
  }
}

/** A child container per panel: Theia's file-tree container with the panel's classes. */
export function createFilePanelWidget(
  parent: interfaces.Container,
  options: FilePanelOptions,
): FilePanelWidget {
  const child = createFileTreeContainer(parent, {
    tree: FilePanelTree,
    model: FilePanelModel,
    widget: FilePanelTreeWidget,
    props: {
      contextMenuPath: FILE_PANEL_CONTEXT_MENU,
      multiSelect: true,
      search: true,
      globalSelection: true,
      expandOnlyOnExpansionToggleClick: true,
      virtualized: true,
    },
  });
  child.bind(FilePanelOptions).toConstantValue(options);
  child.bind(FilePanelWidget).toSelf();
  return child.get(FilePanelWidget);
}
