import type { LabelProvider } from "@theia/core/lib/browser/label-provider";
import type URI from "@theia/core/lib/common/uri";
import * as React from "@theia/core/shared/react";
import { type Crumb, collapseCrumbs, crumbsOf, siblingSource } from "../common/breadcrumb-model";
import { Messages } from "../common/file-panels-nls";

export interface FolderBreadcrumbProps {
  current: URI;
  roots: URI[];
  labels: LabelProvider;
  navigate(uri: URI): void;
  openSiblings(crumb: Crumb, anchor: HTMLElement): void;
  openHidden(hidden: Crumb[], anchor: HTMLElement): void;
  onDropOnCrumb?(uri: URI, event: React.DragEvent): void;
}

const MAX_CRUMBS = 5;

export function FolderBreadcrumb(props: FolderBreadcrumbProps): React.ReactElement {
  const { current, roots, labels } = props;
  const items = collapseCrumbs(crumbsOf(current, roots), MAX_CRUMBS);
  return (
    <nav className="file-panel-breadcrumb">
      {items.map((item) => {
        if (item.kind === "more") {
          return (
            <button
              key="more"
              type="button"
              className="file-panel-more"
              title={Messages.hiddenFolders()}
              onClick={(e) => props.openHidden(item.hidden, e.currentTarget)}
            >
              …
            </button>
          );
        }
        const { crumb } = item;
        const name = labels.getName(crumb.uri);
        const hasSiblings = siblingSource(crumb, roots) !== undefined;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: a drop target only, not clickable itself; the two buttons inside carry the interactive semantics.
          <span
            key={crumb.uri.toString()}
            className="file-panel-crumb"
            data-uri={crumb.uri.toString()}
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDrop={(e) => props.onDropOnCrumb?.(crumb.uri, e)}
          >
            <button
              type="button"
              className="file-panel-crumb-label"
              onClick={() => props.navigate(crumb.uri)}
            >
              {name}
            </button>
            {hasSiblings && (
              <button
                type="button"
                className="file-panel-crumb-toggle codicon codicon-chevron-down"
                title={Messages.siblingsOf(name)}
                onClick={(e) => props.openSiblings(crumb, e.currentTarget)}
              />
            )}
          </span>
        );
      })}
    </nav>
  );
}

export interface FolderListProps {
  folders: { uri: URI; name: string }[];
  current?: URI;
  choose(uri: URI): void;
}

/** The dropdown's content: a keyboard-navigable list of folders. */
export function FolderList({ folders, current, choose }: FolderListProps): React.ReactElement {
  const [focus, setFocus] = React.useState(() =>
    Math.max(
      0,
      folders.findIndex((f) => current && f.uri.isEqual(current)),
    ),
  );
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => listRef.current?.focus(), []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setFocus((i) => Math.min(folders.length - 1, i + 1));
    else if (e.key === "ArrowUp") setFocus((i) => Math.max(0, i - 1));
    else if (e.key === "Enter" && folders[focus]) choose(folders[focus].uri);
    else return;
    e.preventDefault();
  };
  return (
    <div
      className="file-panel-siblings"
      tabIndex={0}
      ref={listRef}
      onKeyDown={onKeyDown}
      role="listbox"
    >
      {folders.map((folder, i) => {
        const activate = () => choose(folder.uri);
        return (
          <div
            key={folder.uri.toString()}
            role="option"
            tabIndex={-1}
            aria-selected={i === focus}
            className={[
              "file-panel-sibling",
              current && folder.uri.isEqual(current) ? "current" : "",
              i === focus ? "focused" : "",
            ].join(" ")}
            onClick={activate}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activate();
              }
            }}
            onMouseEnter={() => setFocus(i)}
          >
            <span className="codicon codicon-folder" /> {folder.name}
          </div>
        );
      })}
    </div>
  );
}
