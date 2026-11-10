/** X3b — native chunked BlobStore + putStaged over statewalker-db's Db. Stub in red. */
import type { Db } from "@statewalker/db-api";
import type { StagingBlobStore } from "../../09-git-objects/src/staging.js";

export interface SqlBlobStoreOptions {
  /** Table name prefix (a plain identifier). Default "blob_". */
  prefix?: string;
  /** Bytes per chunk row; content up to this size is stored inline. Default 1 MiB (DO limit ~2 MB). */
  chunkSize?: number;
}

export async function sqlBlobStore(
  _db: Db,
  _opts: SqlBlobStoreOptions = {},
): Promise<StagingBlobStore> {
  throw new Error("not implemented");
}
