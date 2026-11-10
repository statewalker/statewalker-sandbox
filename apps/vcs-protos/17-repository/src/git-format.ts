/** Git's canonical tree and commit encodings (pure: no I/O). */
export type FileMode = "100644" | "100755" | "120000" | "40000" | "160000";
export interface TreeEntry {
  mode: FileMode;
  name: string;
  oid: string;
}
export interface Person {
  name: string;
  email: string;
  /** seconds since the epoch */
  when: number;
  /** "+hhmm" / "-hhmm" */
  tz: string;
}
export interface CommitData {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}
export function encodeTree(_entries: TreeEntry[]): Uint8Array {
  throw new Error("not implemented");
}
export function parseTree(_bytes: Uint8Array): TreeEntry[] {
  throw new Error("not implemented");
}
export function encodeCommit(_c: CommitData): Uint8Array {
  throw new Error("not implemented");
}
export function parseCommit(_bytes: Uint8Array): CommitData {
  throw new Error("not implemented");
}
