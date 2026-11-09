/** X2 — git's lock-file protocol for ref compare-and-set over FilesApi + two primitives. STUB (red phase). */

/** The FilesApi subset the protocol needs, plus the two primitives this prototype proposes. */
export interface AtomicFiles {
  read(path: string): AsyncIterable<Uint8Array>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  /** Create `path` with `content` only if nothing exists there; `false` (unchanged) otherwise. */
  createExclusive(path: string, content: Uint8Array): Promise<boolean>;
  /** Atomically make `target` hold `source`'s content and remove `source` (rename-over). */
  replace(source: string, target: string): Promise<void>;
}

export type CasResult = "ok" | "mismatch" | "locked";

export async function readRef(_files: AtomicFiles, _ref: string): Promise<string | undefined> {
  throw new Error("not implemented");
}

/** Compare-and-set a loose ref (`undefined` = absent): `<ref>.lock` created exclusively, then renamed over. */
export async function casRef(
  _files: AtomicFiles,
  _ref: string,
  _expected: string | undefined,
  _next: string | undefined,
): Promise<CasResult> {
  throw new Error("not implemented");
}

/** Explicitly remove a stale lock (git requires the same manual step). */
export async function breakLock(_files: AtomicFiles, _ref: string): Promise<boolean> {
  throw new Error("not implemented");
}
