/**
 * X13d — merge-ort, ported along its own structure, with renames (no directory renames).
 */

import type { Repository } from "../../17-repository/src/object-store.js";
import type { TreeMergeOptions, TreeMergeResult } from "../../29-merge/src/merge-trees.js";

export async function mergeOrt(
  _repo: Repository,
  _base: string | undefined,
  _ours: string,
  _theirs: string,
  _opts: TreeMergeOptions,
): Promise<TreeMergeResult> {
  throw new Error("not implemented");
}
