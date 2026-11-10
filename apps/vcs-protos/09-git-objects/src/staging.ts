/**
 * X4 — the one seam addition: put bytes whose id is known only after the last byte.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import type { BlobStore, ByteStream } from "@statewalker/webrun-storage";

export interface StagingBlobStore extends BlobStore {
  /**
   * Store `bytes` under the id that `idOf()` returns once the stream has ended. If `idOf` throws,
   * nothing is stored. If the id already exists, the existing blob is kept (content addressing).
   * Resolves with the id and whether this call stored it.
   */
  putStaged(
    bytes: ByteStream,
    idOf: () => string | Promise<string>,
  ): Promise<{ id: string; stored: boolean }>;
}

/** FilesApi-backed store with git's loose layout: `<root>/ab/cdef…`, temporaries `<root>/tmp_obj_*`. */
export function filesStagingStore(_files: FilesApi, _root: string): StagingBlobStore {
  throw new Error("not implemented");
}

/** Any BlobStore: the stream goes to a temporary id, then is copied to the final id. */
export function withStaging(_store: BlobStore): StagingBlobStore {
  throw new Error("not implemented");
}
