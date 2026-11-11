/**
 * X14 — a working tree on a FilesApi: staging (`add`) and status against the index and HEAD,
 * with stat data deciding what to hash and git's racy-git rules.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import type { Repository } from "../../17-repository/src/object-store.js";
import type { IndexFile } from "./index-file.js";

/** what a stat source reports for a file (FilesApi: size and lastModified only) */
export interface StatInfo {
  size: number;
  mtimeMs: number;
  /** full lstat, where the platform has it */
  mtimeNs?: bigint;
  ctimeNs?: bigint;
  dev?: number;
  ino?: number;
  uid?: number;
  gid?: number;
}
export interface Worktree {
  files: FilesApi;
  /** a richer stat than the FilesApi's, where the platform has one */
  stat?: (path: string) => Promise<StatInfo | undefined>;
}
export interface StatusResult {
  /** `git status --porcelain=v1 --untracked-files=all --no-renames` lines, sorted */
  lines: string[];
  /** how many files were read and hashed */
  hashed: number;
  /** the index with refreshed stat data */
  index: IndexFile;
}

/** stages every file of the working tree (`git add -A`) */
export async function addAll(
  _repo: Repository,
  _wt: Worktree,
  _index: IndexFile | undefined,
  _indexTimestampMs: number,
): Promise<IndexFile> {
  throw new Error("not implemented");
}

/** `git status` of the working tree against the index and HEAD's tree */
export async function status(
  _repo: Repository,
  _wt: Worktree,
  _index: IndexFile,
  _head: string | undefined,
  _indexTimestampMs: number,
): Promise<StatusResult> {
  throw new Error("not implemented");
}
