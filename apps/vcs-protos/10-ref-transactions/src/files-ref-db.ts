/** X5 — git files backend (loose refs, packed-refs, logs) over RefFiles. Stub in red. */
import type { RefDb } from "./ref-db.js";

/** X2's AtomicFiles plus listing and overwriting a file the caller owns (a lock). */
export interface RefFiles {
  read(path: string): AsyncIterable<Uint8Array>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  createExclusive(path: string, content: Uint8Array): Promise<boolean>;
  replace(source: string, target: string): Promise<void>;
  /** Overwrite a file this caller created (its own lock). */
  write(path: string, content: Uint8Array): Promise<void>;
  /** File paths (not directories) under `dir`, recursively. */
  list(dir: string): AsyncIterable<string>;
}

export interface FilesRefDbOptions {
  /** Retry a held ref lock for this long (git: core.filesRefLockTimeout, 100 ms). */
  refLockTimeoutMs?: number;
  /** Retry a held packed-refs.lock for this long (git: core.packedRefsTimeout, 1000 ms). */
  packedLockTimeoutMs?: number;
}

export function filesRefDb(_files: RefFiles, _opts: FilesRefDbOptions = {}): RefDb {
  throw new Error("not implemented");
}
