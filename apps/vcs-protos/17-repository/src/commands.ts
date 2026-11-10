/**
 * The command layer: depends on the ObjectStore and RefDb interfaces and git's formats only (R4).
 */
import type { BatchResult } from "../../10-ref-transactions/src/ref-db.js";
import type { CommitData, Person, TreeEntry } from "./git-format.js";
import type { Repository } from "./repository.js";

export async function writeBlob(_repo: Repository, _bytes: Uint8Array): Promise<string> {
  throw new Error("not implemented");
}
/** Writes nested trees for a { "dir/file": bytes } map; returns the root tree id. */
export async function writeFiles(
  _repo: Repository,
  _files: Record<string, Uint8Array>,
): Promise<string> {
  throw new Error("not implemented");
}
export async function writeTree(_repo: Repository, _entries: TreeEntry[]): Promise<string> {
  throw new Error("not implemented");
}
export async function readTree(_repo: Repository, _oid: string): Promise<TreeEntry[]> {
  throw new Error("not implemented");
}
export async function readCommit(_repo: Repository, _oid: string): Promise<CommitData> {
  throw new Error("not implemented");
}
/**
 * Writes a commit and moves `ref` to it with compare-and-swap: `expected` is the ref's current
 * value (default: the first parent, or "must not exist" for a root commit).
 */
export async function commit(
  _repo: Repository,
  _opts: {
    ref: string;
    tree: string;
    parents?: string[];
    author: Person;
    committer?: Person;
    message: string;
    expected?: string | null;
  },
): Promise<{ oid: string; result: BatchResult }> {
  throw new Error("not implemented");
}
/** `git log`: commits reachable from `ref`, newest committer date first. */
export async function log(_repo: Repository, _ref: string, _limit?: number): Promise<string[]> {
  throw new Error("not implemented");
}
export async function receivePack(
  _repo: Repository,
  _pack: AsyncIterable<Uint8Array>,
): Promise<{ packId: string; count: number }> {
  throw new Error("not implemented");
}
