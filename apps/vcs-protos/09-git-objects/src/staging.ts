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
   * (content addressing: same id, same bytes). Resolves with the id and whether this call stored it.
   */
  putStaged(
    bytes: ByteStream,
    idOf: () => string | Promise<string>,
  ): Promise<{ id: string; stored: boolean }>;
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
      // Like git, an existing object wins: identical id means identical bytes.
      if (await files.exists(target)) {
        await files.remove(tmp);
        return { id, stored: false };
      }
      if (await files.move(tmp, target)) return { id, stored: true };
      // A concurrent writer may have placed it between the check and the move.
      await files.remove(tmp).catch(() => false);
      if (await files.exists(target)) return { id, stored: false };
      throw new Error(`could not move ${tmp} to ${target}`);
    },
  };
}

/**
 * Any BlobStore, without a rename primitive: the stream goes to a temporary id and is copied to
 * the final id. One pass over the source, two over storage — the fallback, not the target.
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
        await store.remove(tmp);
      }
    },
  };
}
