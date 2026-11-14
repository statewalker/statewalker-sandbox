/**
 * One SQL database: refs (X5 sqlRefDb, `refdb_*`), loose objects (X3b rows, `obj_*`) and packs
 * (SqliteFilesApi tables, `pk_*`). One repository per Db (the prefixes are fixed). Opening runs
 * the CREATE IF NOT EXISTS statements and reads the pack indexes: keep a handle per isolate.
 */
import type { Db } from "@statewalker/db-api";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import { gitObjects } from "../../09-git-objects/src/git-objects.js";
import { sqlRefDb } from "../../10-ref-transactions/src/sql-ref-db.js";
import { sqlBlobStore } from "../../11-sql-blob-store/src/sql-blob-store.js";
import { composedStore } from "./composed-store.js";
import type { Repository, StoreOptions } from "./object-store.js";

export async function sqlRepository(db: Db, opts: StoreOptions = {}): Promise<Repository> {
  const packFiles = new SqliteFilesApi(db, { compression: null, tablePrefix: "pk_" });
  await packFiles.init();
  const loose = gitObjects(await sqlBlobStore(db, { prefix: "obj_" }));
  return {
    objects: await composedStore(packFiles, "/objects", loose, {
      ...opts,
      looseOnPackFiles: false,
    }),
    refs: await sqlRefDb(db, "refdb_"),
  };
}
