import type { ColumnDescriptor, TableModel } from "@fm/app";

/**
 * Adapter: TableModel → HighTable's `DataFrame`.
 *
 * HighTable is pull-based (`numRows`, `getCell({row, column, orderBy})`) with
 * an `EventTarget` for change notification, which is the same shape our models
 * already have. So the adapter is a projection, not a bridge: it holds no
 * state, copies no rows, and the model stays the single source of truth.
 *
 * Deliberately typed structurally rather than against the library's types, so
 * `fm-ui` can be built and tested without React and the grid can be swapped
 * for another windowed renderer that speaks the same shape.
 */
export interface ResolvedValue<T = unknown> {
  value: T;
}

export interface DataFrameLike {
  columnDescriptors: { name: string; sortable?: boolean }[];
  numRows: number;
  getRowNumber(args: { row: number }): ResolvedValue<number> | undefined;
  getCell(args: { row: number; column: string }): ResolvedValue | undefined;
  eventTarget: EventTarget;
}

export interface DataFrameAdapter {
  frame: DataFrameLike;
  dispose(): void;
}

export function toDataFrame(model: TableModel): DataFrameAdapter {
  const eventTarget = new EventTarget();

  // One model pulse becomes one `update` event. The grid re-reads what it
  // needs for the current window; nothing is pushed row by row.
  const off = model.onUpdate(() => {
    eventTarget.dispatchEvent(new CustomEvent("update"));
  });

  const frame: DataFrameLike = {
    get columnDescriptors() {
      return model.columns.map((c: ColumnDescriptor) => ({ name: c.key, sortable: c.sortable }));
    },
    get numRows() {
      return model.rowCount;
    },
    getRowNumber({ row }) {
      return row < model.rowCount ? { value: row } : undefined;
    },
    getCell({ row, column }) {
      const value = model.getCell(row, column as ColumnDescriptor["key"]);
      // `undefined` means "not available", which is what the grid renders as a
      // loading cell. An empty string is a VALUE — a directory's blank size.
      return value === undefined ? undefined : { value };
    },
    eventTarget,
  };

  return { frame, dispose: off };
}

/**
 * Sorting is NOT delegated to the grid.
 *
 * The controller already owns sort and filter (C3) and applies them to one
 * listing; letting the grid sort too would make two orderings that can
 * disagree, and the grid's own `orderBy` speaks only in ascending order in the
 * shape we consume. So the grid reports a header click and the controller
 * decides — the same input/level discipline as everywhere else.
 */
export function orderByFor(model: TableModel): { column: string; direction: "ascending" }[] {
  return model.sortDirection === "ascending"
    ? [{ column: model.sortColumn, direction: "ascending" }]
    : [];
}
