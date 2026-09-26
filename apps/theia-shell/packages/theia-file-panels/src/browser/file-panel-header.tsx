import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import * as React from "@theia/core/shared/react";
import { Messages } from "../common/file-panels-nls";
import type { SortColumn, SortState } from "../common/panel-sorting";

export interface FilePanelHeaderState {
  sort: SortState;
  /** A short notice (folder gone, …) or an error, shown under the headings. */
  status?: { text: string; retry?: () => void };
  /** Rendered above the headings; the breadcrumb (Task 7). */
  breadcrumb?: React.ReactNode;
}

export class FilePanelHeader extends ReactWidget {
  state: FilePanelHeaderState;

  constructor(
    initial: FilePanelHeaderState,
    protected readonly onSort: (column: SortColumn) => void,
  ) {
    super();
    this.state = initial;
    this.addClass("file-panel-header");
  }

  setState(patch: Partial<FilePanelHeaderState>): void {
    this.state = { ...this.state, ...patch };
    this.update();
  }

  protected render(): React.ReactNode {
    const { sort, status, breadcrumb } = this.state;
    const column = (id: SortColumn, label: string, className: string) => (
      <button
        type="button"
        className={`file-panel-column ${className}`}
        onClick={() => this.onSort(id)}
      >
        {label}
        {sort.column === id && <span className={`file-panel-sort-mark ${sort.direction}`} />}
      </button>
    );
    return (
      <>
        {breadcrumb}
        <div className="file-panel-columns">
          {column("name", Messages.columnName(), "file-panel-name")}
          {column("size", Messages.columnSize(), "file-panel-size")}
          {column("modified", Messages.columnModified(), "file-panel-modified")}
        </div>
        {status && (
          <div className="file-panel-status" role="status">
            {status.text}
            {status.retry && (
              <button type="button" className="theia-button secondary" onClick={status.retry}>
                {Messages.retry()}
              </button>
            )}
          </div>
        )}
      </>
    );
  }
}
