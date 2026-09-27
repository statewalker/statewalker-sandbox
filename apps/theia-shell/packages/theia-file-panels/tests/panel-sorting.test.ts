import { describe, expect, it } from "vitest";
import {
  compareEntries,
  DEFAULT_SORT,
  type SortEntry,
  toggleSort,
} from "../src/common/panel-sorting";

const f = (name: string, size = 0, mtime = 0): SortEntry => ({
  name,
  isDirectory: false,
  size,
  mtime,
});
const d = (name: string): SortEntry => ({ name, isDirectory: true });
const names = (entries: SortEntry[]) => entries.map((e) => e.name);

describe("compareEntries", () => {
  it("puts folders first, then orders names numerically", () => {
    const list = [f("file10"), d("b"), f("file2"), d("a")];
    expect(names(list.sort(compareEntries(DEFAULT_SORT, "en")))).toEqual([
      "a",
      "b",
      "file2",
      "file10",
    ]);
  });

  it("keeps folders first when descending", () => {
    const list = [f("a"), d("x"), f("b"), d("y")];
    const sorted = list.sort(compareEntries({ column: "name", direction: "desc" }, "en"));
    expect(names(sorted)).toEqual(["y", "x", "b", "a"]);
  });

  it("orders accented names with the locale's collator", () => {
    const list = [f("Zebra"), f("Äpfel"), f("apfel")];
    expect(names(list.sort(compareEntries(DEFAULT_SORT, "de")))).toEqual([
      "apfel",
      "Äpfel",
      "Zebra",
    ]);
  });

  it("sorts by size and by date, ties broken by name", () => {
    const list = [f("c", 5, 3), f("a", 9, 1), f("b", 5, 2)];
    expect(names(list.sort(compareEntries({ column: "size", direction: "asc" }, "en")))).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(
      names(list.sort(compareEntries({ column: "modified", direction: "desc" }, "en"))),
    ).toEqual(["c", "b", "a"]);
  });

  it("treats missing size or date as zero", () => {
    const list = [f("a", 3), { name: "b", isDirectory: false }];
    expect(names(list.sort(compareEntries({ column: "size", direction: "asc" }, "en")))).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("toggleSort", () => {
  it("reverses the active column and starts a new one ascending", () => {
    expect(toggleSort(DEFAULT_SORT, "name")).toEqual({ column: "name", direction: "desc" });
    expect(toggleSort({ column: "name", direction: "desc" }, "size")).toEqual({
      column: "size",
      direction: "asc",
    });
  });
});
