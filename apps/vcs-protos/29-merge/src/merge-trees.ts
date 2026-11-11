/**
 * X13b — merge-ort's tree merge without rename detection (`git merge-tree --write-tree
 * -Xno-renames`): the merged tree, with conflicted files' blobs carrying their markers; the
 * conflicted entries (stages 1, 2, 3 per path); and ort's messages.
 *
 * Path by path (merge-ort.c `process_entry`): a path both sides left as the base had, or changed
 * alike, takes that; a path one side changed takes that side (a deletion included); a path both
 * changed is merged — modes, then content (X13a) for regular files, ours kept for symlinks that
 * conflict — or is a modify/delete or add/add conflict; types that differ (file, symlink,
 * submodule) put each side at `path~<branch>`. A file that survives where the merged tree has a
 * directory moves to `path~<branch of the file>` (file/directory).
 */

import type { Repository } from "../../17-repository/src/object-store.js";
import type { XdOptions } from "./xdiff.js";

export interface Entry {
  mode: string;
  oid: string;
}
export interface ConflictEntry extends Entry {
  stage: 1 | 2 | 3;
  path: string;
}
export interface MergeMessage {
  /** the paths it is about (the first is where it is listed) */
  paths: string[];
  text: string;
}
export interface TreeMergeResult {
  tree: string;
  clean: boolean;
  conflicts: ConflictEntry[];
  messages: MergeMessage[];
}
export interface TreeMergeOptions extends XdOptions {
  /** branch names: conflict markers, `path~<branch>` names, messages */
  ours: string;
  theirs: string;
}

export async function mergeTrees(
  _repo: Repository,
  _base: string | undefined,
  _ours: string,
  _theirs: string,
  _opts: TreeMergeOptions,
): Promise<TreeMergeResult> {
  throw new Error("not implemented");
}
