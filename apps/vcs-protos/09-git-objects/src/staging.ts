/**
 * X4 — the one seam addition: put bytes whose id is known only after the last byte.
 *
 * `BlobStore.put(id, bytes)` needs the id first, but a streamed git object's id is the hash of
 * the bytes themselves. Git writes `objects/tmp_obj_XXXXXX` and renames it once the hash is known
 * (`finalize_object_file`); JGit's `ObjectDirectoryInserter` does the same (`toTemp`, then
 * `insertOneObject`). `putStaged` is that step as a storage method.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { type BlobStore, type ByteStream, filesBlobStore } from "@statewalker/webrun-storage";

export interface StagingBlobStore extends BlobStore {
  /**
   * Store `bytes` under the id that `idOf()` returns once the stream has ended. If the stream or
   * `idOf` throws, nothing is stored. If the id already exists, the existing blob is kept
   * (content addressing: same id, same content). Resolves with the id and whether this call
   * stored it. `stored` is advisory under concurrency: FilesApi.move overwrites, so two writers
   * racing on a new id may both report `true` (the last rename wins, with identical content).
   */
  putStaged(
    bytes: ByteStream,
    idOf: () => string | Promise<string>,
  ): Promise<{ id: string; stored: boolean }>;
  /** Removes staged temporaries older than `olderThanMs` (left by a crash); returns how many. */
  sweepStaged?(olderThanMs: number): Promise<number>;
}

/** git's temporary-object name: `tmp_obj_` plus random characters. */
function tmpName(): string {
  const r = crypto.getRandomValues(new Uint8Array(9));
  return `tmp_obj_${btoa(String.fromCharCode(...r)).replace(/[+/]/g, "_")}`;
}

/**
 * FilesApi-backed store with git's loose layout: `<root>/ab/cdef…`, temporaries written as
 * `<root>/tmp_obj_*` and renamed into place (a metadata-only move on Node, SqliteFilesApi and
 * MemFilesApi). Rooted at `.git/objects`, this is the object database native git reads.
 */
export function filesStagingStore(files: FilesApi, root: string): StagingBlobStore {
  const base = root.replace(/\/+$/, "");
  const blobs = filesBlobStore(files, { root: base });
  const pathFor = (id: string) => `${base}/${id.slice(0, 2)}/${id.slice(2)}`;
  return {
    ...blobs,
    async putStaged(bytes, idOf) {
      const tmp = `${base}/${tmpName()}`;
      let id: string;
      try {
        await files.write(tmp, bytes);
        id = await idOf();
      } catch (e) {
        await files.remove(tmp).catch(() => false);
        throw e;
      }
      const target = pathFor(id);
      // An existing object wins, as in git — except against a concurrent writer of the same new id:
      // FilesApi.move overwrites (git uses link() + EEXIST), so the last rename wins. Both files
      // hold the same content, and each rename is atomic on Node and SqliteFilesApi.
      if (await files.exists(target)) {
        await files.remove(tmp);
        return { id, stored: false };
      }
      if (await files.move(tmp, target)) return { id, stored: true };
      // The move failed (e.g. the target directory vanished): keep whatever is there, drop ours.
      await files.remove(tmp).catch(() => false);
      if (await files.exists(target)) return { id, stored: false };
      throw new Error(`could not move ${tmp} to ${target}`);
    },
    async sweepStaged(olderThanMs) {
      // git prune removes tmp_* files older than its expiry, at the top level and in fan-out
      // directories; this does the same for stores git never touches (OPFS, SQLite, DO).
      const cutoff = Date.now() - olderThanMs;
      const stale: string[] = [];
      for await (const info of files.list(base || "/", { recursive: true })) {
        const name = info.path.slice(info.path.lastIndexOf("/") + 1);
        if (info.kind === "file" && name.startsWith("tmp_obj_") && info.lastModified < cutoff) {
          stale.push(info.path);
        }
      }
      for (const p of stale) await files.remove(p);
      return stale.length;
    },
  };
}

/**
 * Any BlobStore, without a rename primitive: the stream goes to a temporary id and is copied to
 * the final id. One pass over the source, two over storage — the fallback, not the target.
 * Safe only where `put` is all-or-nothing (memBlobStore buffers, then sets): on a store whose put
 * streams, a crash during the copy leaves a partial blob at the final id that `has` then accepts.
 */
export function withStaging(store: BlobStore): StagingBlobStore {
  return {
    put: (id, bytes, opts) => store.put(id, bytes, opts),
    get: (id, range) => store.get(id, range),
    has: (id) => store.has(id),
    remove: (id) => store.remove(id),
    size: (id) => store.size(id),
    list: (prefix) => store.list(prefix),
    async putStaged(bytes, idOf) {
      const tmp = tmpName();
      let id: string;
      try {
        await store.put(tmp, bytes);
        id = await idOf();
      } catch (e) {
        await store.remove(tmp).catch(() => false);
        throw e;
      }
      try {
        if (await store.has(id)) return { id, stored: false };
        await store.put(id, store.get(tmp));
        return { id, stored: true };
      } finally {
        await store.remove(tmp).catch(() => false); // never mask the copy's own error
      }
    },
  };
}
