import { currentLocale } from "./locale";

export type SortColumn = "name" | "size" | "modified";
export interface SortState {
  column: SortColumn;
  direction: "asc" | "desc";
}
export const DEFAULT_SORT: SortState = { column: "name", direction: "asc" };

export interface SortEntry {
  name: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
}

/** Folders first (in both directions), then the column; ties broken by name. */
export function compareEntries(
  state: SortState,
  locale = currentLocale(),
): (a: SortEntry, b: SortEntry) => number {
  const loose = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const strict = new Intl.Collator(locale, { numeric: true, sensitivity: "variant" });
  const byName = (a: SortEntry, b: SortEntry) =>
    loose.compare(a.name, b.name) || strict.compare(a.name, b.name);
  const sign = state.direction === "asc" ? 1 : -1;
  return (a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let order = 0;
    if (state.column === "size") order = (a.size ?? 0) - (b.size ?? 0);
    else if (state.column === "modified") order = (a.mtime ?? 0) - (b.mtime ?? 0);
    return sign * (order || byName(a, b));
  };
}

/** Clicking a column header: the active column reverses, another column starts ascending. */
export function toggleSort(state: SortState, column: SortColumn): SortState {
  if (state.column === column) {
    return { column, direction: state.direction === "asc" ? "desc" : "asc" };
  }
  return { column, direction: "asc" };
}
