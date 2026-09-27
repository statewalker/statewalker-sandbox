import type { FileStats } from "@statewalker/webrun-files";

/**
 * P1 — the proposed upstream shape of `FileStats`.
 *
 * Size and time are not available for DIRECTORIES, but are always available
 * for FILES. Making `kind` a discriminant instead of a field removes the
 * option of letting `undefined` fudge the difference — which is exactly what
 * forces S3 to decide whether a common prefix is a directory and whether a
 * zero-byte marker object is a file with `size: 0`.
 */
export type Stats = { kind: "file"; size: number; lastModified: number } | { kind: "directory" };

/**
 * Migration shim standing in for the type flip. Once the union lands upstream
 * this disappears; until then it enforces at runtime what the type will
 * enforce at compile time, so the conformance suite can run first.
 */
export function narrowStats(stats: FileStats | Stats): Stats {
  if (stats.kind === "directory") {
    // Extras are DROPPED, not rejected. Some adapters (mem, node) can report a
    // directory mtime and others (S3) cannot; requiring its absence would make
    // adapters hide information, and requiring its presence would reinstate the
    // per-adapter capability table this design rejected. The union says what a
    // consumer may rely on, and narrowing is the barrier that enforces it.
    return { kind: "directory" };
  }
  const { size, lastModified } = stats as { size?: number; lastModified?: number };
  if (typeof size !== "number" || typeof lastModified !== "number") {
    throw new Error("not the file variant: size and lastModified are required on files");
  }
  return { kind: "file", size, lastModified };
}

/** A directory shows a blank size cell, as every commander does. */
export function sizeCell(stats: Stats): string {
  return stats.kind === "directory" ? "" : String(stats.size);
}

/** Directories sort as a separate group, ahead of files, in every column. */
export function compareEntries(
  column: "name" | "size" | "date",
): (a: { name: string; stats: Stats }, b: { name: string; stats: Stats }) => number {
  return (a, b) => {
    const ad = a.stats.kind === "directory" ? 0 : 1;
    const bd = b.stats.kind === "directory" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    if (a.stats.kind === "directory" || b.stats.kind === "directory") {
      return a.name.localeCompare(b.name);
    }
    if (column === "size") return a.stats.size - b.stats.size;
    if (column === "date") return a.stats.lastModified - b.stats.lastModified;
    return a.name.localeCompare(b.name);
  };
}

/**
 * The same ordering over a raw `FileInfo` from `list()`, whose stats are flat
 * fields rather than a nested object. Narrowing happens here, so a caller
 * cannot accidentally sort on a size a directory never had.
 */
export function compareInfos(
  column: "name" | "size" | "date",
): (a: { name: string; kind: string }, b: { name: string; kind: string }) => number {
  const inner = compareEntries(column);
  return (a, b) =>
    inner(
      { name: a.name, stats: narrowStats(a as never) },
      { name: b.name, stats: narrowStats(b as never) },
    );
}
