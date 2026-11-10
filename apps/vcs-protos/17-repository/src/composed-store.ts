/**
 * The ObjectStore every backend is: packs (X6b2 install, X6r read) under `<objectsDir>/pack` on a
 * FilesApi, plus loose objects through X4's kernel. Reads consult the packs first (git's
 * find_pack_entry), then loose objects; on a miss the pack directory is rescanned once (git's
 * reprepare_packed_git): another handle or native git may have added a pack.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import type { GitObjects } from "../../09-git-objects/src/git-objects.js";
import { openObjectDatabase } from "../../13-pack-reader/src/object-db.js";
import { installPack, sweepPackTemporaries } from "../../15-resumable-index/src/index-job.js";
import type { ObjectStore, ObjectType, StoredObject, StoreOptions } from "./object-store.js";

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

/** Temporaries of interrupted installs older than this are removed at open (git prune's 2 weeks). */
const STALE_MS = 14 * 24 * 3600 * 1000;

export async function composedStore(
  packFiles: FilesApi,
  objectsDir: string,
  loose: GitObjects,
  opts: StoreOptions & {
    /** The pack database also reads loose objects (they live on `packFiles`): read them once. */
    looseOnPackFiles: boolean;
  },
): Promise<ObjectStore> {
  const maxObjectSize = opts.maxObjectSize ?? 2 ** 30;
  const packDir = `${objectsDir}/pack`;
  await sweepPackTemporaries(packFiles, packDir, { olderThanMs: STALE_MS }).catch(() => []);
  let packs = await openObjectDatabase(packFiles, objectsDir, { maxObjectSize });
  let rescanning: Promise<void> | undefined;
  const rescan = () => {
    rescanning ??= openObjectDatabase(packFiles, objectsDir, { maxObjectSize })
      .then((db) => {
        packs = db;
      })
      .finally(() => {
        rescanning = undefined;
      });
    return rescanning;
  };
  const find = async (oid: string, o?: { verify?: boolean }) => {
    const p = await packs.get(oid, o);
    if (p) return p as StoredObject;
    if (!opts.looseOnPackFiles) return (await loose.get(oid, o)) as StoredObject | undefined;
    return undefined;
  };
  let installing: Promise<unknown> = Promise.resolve();
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
    async get(oid, o) {
      const found = await find(oid, o);
      if (found) return found;
      await rescan();
      return (await packs.get(oid, o)) as StoredObject | undefined;
    },
    async packedEntry(oid) {
      return packs.entry(oid);
    },
    async has(oid) {
      const here = async () =>
        (await packs.has(oid)) || (!opts.looseOnPackFiles && (await loose.has(oid)));
      if (await here()) return true;
      await rescan();
      return packs.has(oid);
    },
    async *list() {
      const seen = new Set<string>();
      const sources = opts.looseOnPackFiles ? [packs.list()] : [packs.list(), loose.list()];
      for (const source of sources)
        for await (const id of source) {
          if (seen.has(id)) continue;
          seen.add(id);
          yield id;
        }
    },
    async installPack(source) {
      // one install at a time per handle: each reopens the pack database after its rename
      const run = installing.then(async () => {
        const r = await installPack(packFiles, packDir, source, {
          maxObjectSize,
          maxPackSize: opts.maxPackSize,
          // a thin pack's missing bases are objects this store already has (bounded like entries)
          externalBase: async (oid) => {
            const o = await store.get(oid);
            if (!o) return undefined;
            if (o.size > maxObjectSize) {
              await o.content[Symbol.asyncIterator]().return?.();
              throw new Error(
                `base ${oid} (${o.size} bytes) is over the limit of ${maxObjectSize}`,
              );
            }
            return { type: o.type, data: await collect(o.content) };
          },
        });
        await rescan();
        return { packId: r.packId, count: r.count };
      });
      installing = run.catch(() => {});
      return run;
    },
  };
  return store;
}
