/**
 * The ObjectStore every backend is: packs (X6b2 install, X6r read) under `<objectsDir>/pack` on a
 * FilesApi, plus loose objects through X4's kernel. Reads consult the packs first (git's
 * find_pack_entry), then loose objects; on a miss the pack directory is rescanned once (git's
 * reprepare_packed_git): another handle or native git may have added a pack.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import type { GitObjects } from "../../09-git-objects/src/git-objects.js";
import { openObjectDatabase } from "../../13-pack-reader/src/object-db.js";
import { PackError } from "../../13-pack-reader/src/pack-reader.js";
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
  // reopens after installs, in order: a reopen that began before a pack's rename would miss it
  let reopening: Promise<void> = Promise.resolve();
  const reopenAfterInstall = () => {
    const run = reopening.then(async () => {
      packs = await openObjectDatabase(packFiles, objectsDir, { maxObjectSize });
    });
    reopening = run.catch(() => {});
    return run;
  };
  const root = objectsDir.replace(/\/objects$/, "");
  const gcDir = `${root}/gc`;
  /**
   * git freshens an object written again (its mtime): gc's grace restarts. Here a marker under
   * gc/fresh names it (a loose id, or a whole pack) — written only once gc is in use (its ledger
   * exists); gc consumes the markers.
   */
  const freshen = async (name: string) => {
    if (!(await packFiles.exists(`${gcDir}/ledger.json`).catch(() => false))) return;
    await packFiles.write(`${gcDir}/fresh/${name}`, [new Uint8Array(0)]).catch(() => {});
  };
  // a handle opened before another handle's gc holds idx tables of removed packs: a read that
  // fails on such a copy rescans once and retries
  // — only when the pack set changed: a corrupt copy in an unchanged set stays refused (a fresh
  // database would forget X6r's bad-copy marks and read it again)
  const retrying = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (e) {
      if (!(e instanceof PackError)) throw e;
      const before = packs
        .readers()
        .map((r) => r.packId)
        .sort()
        .join();
      await reopenAfterInstall();
      if (
        packs
          .readers()
          .map((r) => r.packId)
          .sort()
          .join() === before
      )
        throw e;
      return read();
    }
  };
  const store: ObjectStore = {
    async put(type: ObjectType, content: Uint8Array) {
      const id = await loose.put(
        type,
        content.length,
        (async function* () {
          yield content;
        })(),
      );
      await freshen(`l-${id}`);
      return id;
    },
    async get(oid, o) {
      const found = await retrying(() => find(oid, o));
      if (found) return found;
      await rescan();
      return (await retrying(() => packs.get(oid, o))) as StoredObject | undefined;
    },
    gc: {
      files: packFiles,
      dir: gcDir,
      root,
      packs: () => packs.readers().map((r) => ({ packId: r.packId, ids: () => r.ids() })),
      async keptPacks() {
        const kept = new Set<string>();
        for (const r of packs.readers())
          if (await packFiles.exists(`${packDir}/pack-${r.packId}.keep`)) kept.add(r.packId);
        return kept;
      },
      loose: () => loose.list(),
      removeLoose: (oid) => loose.remove(oid),
      refresh: () => reopenAfterInstall(),
      async removePacks(packIds) {
        // idx first: a pack without its idx is ignored by new readers (X6r); open handles rescan
        // on a failed read. Then the pack and its companions (git's .rev, .bitmap, .mtimes, …).
        for (const id of packIds)
          for (const ext of ["idx", "pack", "rev", "bitmap", "mtimes", "promisor"])
            await packFiles.remove(`${packDir}/pack-${id}.${ext}`).catch(() => false);
        await reopenAfterInstall();
      },
    },
    async packedEntry(oid) {
      return retrying(() => packs.entry(oid));
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
      // installs run concurrently (each is its own job, under its own temporary names): a slow or
      // stalled upload must not hold the others; only the reopen after each rename is ordered
      {
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
        await reopenAfterInstall();
        await freshen(`p-${r.packId}`);
        return { packId: r.packId, count: r.count };
      }
    },
  };
  return store;
}
