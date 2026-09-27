import { BreadcrumbPopupContainerFactory } from "@theia/core/lib/browser/breadcrumbs/breadcrumb-popup-container";
import { LabelProvider } from "@theia/core/lib/browser/label-provider";
import type { StatefulWidget } from "@theia/core/lib/browser/shell/shell-layout-restorer";
import { SelectableTreeNode } from "@theia/core/lib/browser/tree/tree-selection";
import { BaseWidget, type Message } from "@theia/core/lib/browser/widgets/widget";
import URI from "@theia/core/lib/common/uri";
import { PanelLayout, type Widget } from "@theia/core/shared/@lumino/widgets";
import { inject, injectable, type interfaces } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { createRoot } from "@theia/core/shared/react-dom/client";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { createFileTreeContainer } from "@theia/filesystem/lib/browser/file-tree";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { type Crumb, siblingSource } from "../common/breadcrumb-model";
import { Messages } from "../common/file-panels-nls";
import { compareEntries, type SortState, toggleSort } from "../common/panel-sorting";
import { FilePanelHeader } from "./file-panel-header";
import { FilePanelModel, FilePanelTree } from "./file-panel-tree";
import { FilePanelTreeWidget } from "./file-panel-tree-widget";
import { FolderBreadcrumb, FolderList } from "./folder-breadcrumb";

export const FILE_PANEL_CONTEXT_MENU = ["file-panel-context-menu"];

export const FilePanelOptions = Symbol("FilePanelOptions");
export interface FilePanelOptions {
  id: string;
  folder?: string;
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

  protected header!: FilePanelHeader;

  /** A notice shown until the next navigation (a folder that disappeared). */
  protected notice: string | undefined;

  get model(): FilePanelModel {
    return this.tree.model;
  }

  get folder(): URI | undefined {
    return this.model.location;
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
      this.tree.onDidDrop.event(async (uris) => {
        await this.model.refresh();
        const nodes = uris
          .filter((uri) => this.folder && uri.parent.isEqual(this.folder))
          .map((uri) => this.model.getNode(uri.path.toString()))
          .filter((node): node is SelectableTreeNode => SelectableTreeNode.is(node));
        nodes.forEach((node, i) => {
          if (i === 0) this.model.selectNode(node);
          else this.model.addSelection(node);
        });
      }),
      this.files.onDidFilesChange((event) => {
        const folder = this.folder;
        if (folder && event.changes.some((change) => change.resource.isEqualOrParent(folder))) {
          void this.files.exists(folder).then((exists) => {
            if (!exists && this.folder?.isEqual(folder)) void this.navigateToExisting(folder);
          });
        }
      }),
    ]);
    const start = this.options.folder ? new URI(this.options.folder) : await this.defaultFolder();
    await this.navigateTo(start);
  }

  storeState(): object {
    return { folder: this.folder?.toString(), sort: this.sort };
  }

  restoreState(state: { folder?: string; sort?: SortState }): void {
    if (state.sort) this.setSort(state.sort);
    if (state.folder) void this.navigateToExisting(new URI(state.folder));
  }

  /** `uri`, or its nearest existing ancestor, or the first workspace root. */
  protected async navigateToExisting(uri: URI): Promise<void> {
    for (let candidate = uri; ; candidate = candidate.parent) {
      if (await this.files.exists(candidate)) {
        await this.navigateTo(candidate);
        if (!candidate.isEqual(uri)) {
          this.notice = Messages.folderGone(uri.path.base, this.labels.getName(candidate));
          this.updateEmptyState();
        }
        return;
      }
      if (candidate.path.isRoot) break;
    }
    await this.navigateTo(await this.defaultFolder());
  }

  async navigateTo(uri: URI): Promise<void> {
    this.notice = undefined;
    await this.model.navigateToFolder(uri);
  }

  async goUp(): Promise<void> {
    const folder = this.folder;
    if (folder && !folder.path.isRoot) await this.navigateTo(folder.parent);
  }

  async refresh(): Promise<void> {
    await this.model.refresh();
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
        onDropOnCrumb: (uri, event) => {
          event.preventDefault();
          void this.tree.dropOnFolder(uri, event);
        },
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
    const box = anchor.getBoundingClientRect();
    const popup = this.popups(this.node, `file-panel-siblings:${this.id}`, {
      x: box.left,
      y: box.bottom,
    });
    const root = createRoot(popup.container);
    popup.onDidDispose(() => root.unmount());
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
    const error = this.fileTree.listingError;
    const root = this.model.root;
    const empty = !error && root && "children" in root && (root.children as unknown[]).length === 0;
    this.header.setState({
      status: error
        ? { text: Messages.notAvailable(this.title.label, error), retry: () => void this.refresh() }
        : this.notice
          ? { text: this.notice }
          : empty
            ? { text: Messages.emptyFolder() }
            : undefined,
    });
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
