import { narrowStats, sizeCell } from "@fm/core";
import { BaseClass } from "@statewalker/shared-baseclass";
import type { FileInfo } from "@statewalker/webrun-files";

export interface ColumnDescriptor {
  key: "name" | "size" | "date";
  /** i18n key, not prose. */
  labelKey: string;
  sortable: boolean;
  align: "start" | "end";
}

export type SortDirection = "ascending" | "descending";

/**
 * The table is driven by a MODEL, not by props.
 *
 * A grid library that owns rows, sort, filter and selection would be a second
 * source of truth beside the panel — and the panel already owns all four
 * (C3). So the view layer gets a read-only projection it can pull from, and
 * writes back only through `input`, exactly like every other view.
 *
 * The shape here is deliberately PULL-based (`rowCount` + `getCell(row, col)`)
 * rather than an array of rows: that is what a windowed grid actually needs at
 * 100k entries, and it means the model never has to materialise a second copy
 * of the listing to render it.
 */
export class TableModel extends BaseClass {
  columns: ColumnDescriptor[] = [
    { key: "name", labelKey: "column.name", sortable: true, align: "start" },
    { key: "size", labelKey: "column.size", sortable: true, align: "end" },
    { key: "date", labelKey: "column.date", sortable: true, align: "end" },
  ];

  sortColumn: ColumnDescriptor["key"] = "name";
  sortDirection: SortDirection = "ascending";

  /** Cursor position, as a row index into the current projection. */
  cursor = 0;

  /**
   * Selection is keyed by PATH, never by row index.
   *
   * An index-keyed selection silently shifts the moment a listing refreshes —
   * and C4 refreshes listings from underneath the user whenever a job touches
   * the directory. Ranges are computed for rendering, at render time.
   */
  selected: ReadonlySet<string> = new Set();

  /** Rows marked as changing, by path — mirrors PanelModel.marks. */
  marks: Record<string, { jobId?: string; kind: string }> = {};

  private _rows: FileInfo[] = [];

  /** Written by the controller from the panel's projection. */
  setRows(rows: FileInfo[]): void {
    this._rows = rows;
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
    this.notify();
  }

  get rowCount(): number {
    return this._rows.length;
  }

  /** Stable identity of a row. The selection and the marks both key on this. */
  getRowKey(row: number): string | undefined {
    return this._rows[row]?.path;
  }

  getRow(row: number): FileInfo | undefined {
    return this._rows[row];
  }

  /**
   * Returns `undefined` for a row that is not available, which is exactly what
   * a windowed grid expects for "still loading" — so a streamed or paged
   * listing needs no extra vocabulary later.
   */
  getCell(row: number, column: ColumnDescriptor["key"]): string | undefined {
    const entry = this._rows[row];
    if (!entry) return undefined;
    if (column === "name") return entry.name;
    const stats = narrowStats(entry as never);
    if (column === "size") return sizeCell(stats);
    return stats.kind === "directory" ? "" : new Date(stats.lastModified).toISOString();
  }

  isSelected(row: number): boolean {
    const key = this.getRowKey(row);
    return key !== undefined && this.selected.has(key);
  }

  markOf(row: number): { jobId?: string; kind: string } | undefined {
    const key = this.getRowKey(row);
    return key === undefined ? undefined : this.marks[key];
  }

  /**
   * Contiguous index ranges over the CURRENT projection, for grids whose
   * selection API speaks in ranges. Derived on demand: the truth stays the
   * path set.
   */
  selectionRanges(): { start: number; end: number }[] {
    const ranges: { start: number; end: number }[] = [];
    for (let row = 0; row < this._rows.length; row++) {
      if (!this.isSelected(row)) continue;
      const last = ranges[ranges.length - 1];
      if (last && last.end === row) last.end = row + 1;
      else ranges.push({ start: row, end: row + 1 });
    }
    return ranges;
  }
}
