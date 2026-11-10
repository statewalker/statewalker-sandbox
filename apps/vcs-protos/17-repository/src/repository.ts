/**
 * Backends. Each is the same composition — packs (X6b2 install, X6r read) on a FilesApi plus loose
 * objects through X4's kernel — over different storage, with X5's RefDb:
 *  - git files: FilesApi rooted at `.git` (packs and loose objects in `objects/`), filesRefDb;
 *  - SQL: one Db holding refs (sqlRefDb), loose objects (X3b rows) and packs (SqliteFilesApi tables).
 */
import type { Db } from "@statewalker/db-api";
import type { FilesApi } from "@statewalker/webrun-files";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import { type GitObjects, gitObjects } from "../../09-git-objects/src/git-objects.js";
import { filesStagingStore } from "../../09-git-objects/src/staging.js";
import { filesRefDb, type RefFiles } from "../../10-ref-transactions/src/files-ref-db.js";
import type { RefDb } from "../../10-ref-transactions/src/ref-db.js";
import { sqlRefDb } from "../../10-ref-transactions/src/sql-ref-db.js";
import { sqlBlobStore } from "../../11-sql-blob-store/src/sql-blob-store.js";
import { openObjectDatabase } from "../../13-pack-reader/src/object-db.js";
import { installPack } from "../../15-resumable-index/src/index-job.js";
import type { ObjectStore, ObjectType, StoredObject } from "./object-store.js";

export interface Repository {
  objects: ObjectStore;
  refs: RefDb;
}

async function collect(s: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of s) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Packs under `<objectsDir>/pack` on `packFiles` (git's layout), loose objects in `loose`. Reads
 * consult the packs first (git's find_pack_entry), then loose objects.
 */
async function composedStore(
  packFiles: FilesApi,
  objectsDir: string,
  loose: GitObjects,
): Promise<ObjectStore> {
  let packs = await openObjectDatabase(packFiles, objectsDir);
  const store: ObjectStore = {
    async put(type: ObjectType, content: Uint8Array) {
      return loose.put(
        type,
        content.length,
        (async function* () {
          yield content;
        })(),
      );
    },
    async get(oid, opts) {
      const p = await packs.get(oid, opts);
      if (p) return p as StoredObject;
      return (await loose.get(oid, opts)) as StoredObject | undefined;
    },
    async has(oid) {
      return (await packs.has(oid)) || (await loose.has(oid));
    },
    async *list() {
      const seen = new Set<string>();
      for (const source of [packs.list(), loose.list()])
        for await (const id of source) {
          if (seen.has(id)) continue;
          seen.add(id);
          yield id;
        }
    },
    async installPack(source) {
      const r = await installPack(packFiles, `${objectsDir}/pack`, source, {
        // a thin pack's missing bases are objects this store already has
        externalBase: async (oid) => {
          const o = await store.get(oid);
          return o ? { type: o.type, data: await collect(o.content) } : undefined;
        },
      });
      packs = await openObjectDatabase(packFiles, objectsDir); // see the new pack
      return { packId: r.packId, count: r.count };
    },
  };
  return store;
}

/** git files: `files` rooted at `.git`; `refFiles` the same directory for X5's ref store. */
export async function filesRepository(
  files: FilesApi,
  refFiles: RefFiles,
  objectsDir = "/objects",
): Promise<Repository> {
  const loose = gitObjects(filesStagingStore(files, objectsDir));
  return { objects: await composedStore(files, objectsDir, loose), refs: filesRefDb(refFiles) };
}

/** One SQL database: refs, loose objects as rows, packs as SqliteFilesApi files. */
export async function sqlRepository(db: Db): Promise<Repository> {
  const packFiles = new SqliteFilesApi(db, { compression: null, tablePrefix: "pk_" });
  await packFiles.init();
  const loose = gitObjects(await sqlBlobStore(db, { prefix: "obj_" }));
  return {
    objects: await composedStore(packFiles, "/objects", loose),
    refs: await sqlRefDb(db, "refdb_"),
  };
}
