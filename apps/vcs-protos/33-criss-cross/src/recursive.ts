/**
 * X13f — merge-ort's recursive merge (`merge_ort_internal`) over commits: git's merge bases
 * (`get_merge_bases`), merged pairwise into virtual merge bases, then the outer merge.
 */

import type { Repository } from "../../17-repository/src/object-store.js";
import type { TreeMergeOptions, TreeMergeResult } from "../../29-merge/src/merge-trees.js";

/** `git merge-base --all a b`, in git's order */
export async function mergeBases(_repo: Repository, _a: string, _b: string): Promise<string[]> {
  throw new Error("not implemented");
}

/** `git merge-tree --write-tree a b`: the merge of two commits, recursive over their merge bases */
export async function mergeCommits(
  _repo: Repository,
  _ours: string,
  _theirs: string,
  _opts: TreeMergeOptions & { allowUnrelated?: boolean },
): Promise<TreeMergeResult> {
  throw new Error("not implemented");
}
