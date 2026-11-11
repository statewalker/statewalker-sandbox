/**
 * X13c — git's rename detection (`diffcore-rename.c` with `diffcore-delta.c`'s similarity), over a
 * diff of two trees, as `git diff-tree -r -M` gives it.
 */

import type { Repository } from "../../17-repository/src/object-store.js";

export interface DiffEntry {
  status: "A" | "D" | "M" | "T" | "R" | "C";
  /** similarity percent, for renames */
  score?: number;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  oldPath: string;
  newPath: string;
}
export interface RenameOptions {
  /** minimum similarity percent (`-M<n>%`), 50 by default */
  score?: number;
  /** rename limit (`-l<n>`): no inexact detection past limit² candidate pairs; ≤ 0 unlimited */
  limit?: number;
  /** empty files can be renames (diff's default; merge-ort turns it off) */
  renameEmpty?: boolean;
}

export async function diffTrees(
  _repo: Repository,
  _a: string | undefined,
  _b: string | undefined,
  _opts: RenameOptions = {},
): Promise<DiffEntry[]> {
  throw new Error("not implemented");
}
