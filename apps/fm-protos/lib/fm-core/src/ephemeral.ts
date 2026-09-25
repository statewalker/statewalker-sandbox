import type { FileInfo, FileStats, FilesApi } from "@statewalker/webrun-files";

/**
 * Ephemeral storages: built for the duration of ONE job and never entered in
 * the registry. They have no `storageURI` anybody could reference later,
 * because there is nothing to come back to.
 */

/**
 * A read-only view. Dropped OS handles become one of these, so ingest is an
 * ordinary copy job — batching, progress, cancel and checkpointing all
 * inherited rather than reimplemented for drag-and-drop.
 */
export function readOnly(api: FilesApi): FilesApi {
  const refuse = (operation: string) => () => {
    throw new Error(`${operation} is not available on a read-only storage`);
  };
  return {
    read: (path: string, options?: never) => api.read(path, options),
    list: (path: string, options?: never) => api.list(path, options),
    stats: (path: string) => api.stats(path),
    exists: (path: string) => api.exists(path),
    write: refuse("write"),
    mkdir: refuse("mkdir"),
    remove: refuse("remove"),
    move: refuse("move"),
    copy: refuse("copy"),
  } as unknown as FilesApi;
}

export interface ArchiveEntry {
  path: string;
  bytes: number;
}

/**
 * A streaming archive sink: genuinely WRITE-ONLY.
 *
 * It cannot be read, listed or resumed — so it declares `resumable: false`,
 * and the engine skips checkpointing rather than writing a cursor it could
 * never honour. Declaring the truth is cheaper than discovering it on resume.
 */
export function archiveSink(): FilesApi & { resumable: false; entries: ArchiveEntry[] } {
  const entries: ArchiveEntry[] = [];
  const refuse = (operation: string) => () => {
    throw new Error(`${operation} is not available on a write-only archive`);
  };
  return {
    resumable: false,
    entries,
    async write(path: string, content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
      let bytes = 0;
      for await (const chunk of content as AsyncIterable<Uint8Array>) bytes += chunk.length;
      entries.push({ path, bytes });
      return true;
    },
    async mkdir() {
      return true;
    },
    async exists() {
      return false;
    },
    read: refuse("read"),
    list: refuse("list"),
    stats: refuse("stats"),
    remove: refuse("remove"),
    move: refuse("move"),
    copy: refuse("copy"),
  } as unknown as FilesApi & { resumable: false; entries: ArchiveEntry[] };
}

export type { FileInfo, FileStats };
