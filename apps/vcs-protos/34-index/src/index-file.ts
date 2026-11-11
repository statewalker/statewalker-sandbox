/**
 * X14 — git's index file (read-cache.c): versions 2, 3 and 4, extensions kept.
 */

export interface IndexEntry {
  ctimeSec: number;
  ctimeNsec: number;
  mtimeSec: number;
  mtimeNsec: number;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  oid: string;
  stage: 0 | 1 | 2 | 3;
  assumeValid: boolean;
  skipWorktree: boolean;
  intentToAdd: boolean;
  path: string;
}
export interface IndexExtension {
  signature: string;
  data: Uint8Array;
}
export interface IndexFile {
  version: 2 | 3 | 4;
  entries: IndexEntry[];
  extensions: IndexExtension[];
}

export function parseIndex(_bytes: Uint8Array): IndexFile {
  throw new Error("not implemented");
}
export function serializeIndex(_index: IndexFile): Uint8Array {
  throw new Error("not implemented");
}
