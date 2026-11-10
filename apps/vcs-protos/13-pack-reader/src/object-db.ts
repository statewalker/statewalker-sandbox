/**
 * X6r — git's object database over FilesApi: every installed pack (`objects/pack/*.idx` with its
 * `.pack`) plus loose objects through X4's kernel. Packs are consulted first (git's
 * find_pack_entry), then loose objects. A REF_DELTA base outside its pack is resolved through the
 * whole database.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { gitObjects } from "../../09-git-objects/src/git-objects.js";
import { filesStagingStore } from "../../09-git-objects/src/staging.js";
import {
  openPack,
  PackError,
  type PackedEntry,
  type PackReader,
  type PackReaderOptions,
  type ReadObject,
} from "./pack-reader.js";

export interface ObjectDatabase {
  get(
    oid: string,
    opts?: { verify?: boolean; visiting?: Set<string> },
  ): Promise<ReadObject | undefined>;
  has(oid: string): Promise<boolean>;
  list(): AsyncIterable<string>;
  /** The object's entry in the first pack that holds it (X6d: reuse when exporting). */
  entry(oid: string): Promise<PackedEntry | undefined>;
  /** Packs that could not be opened (corrupt idx, mismatched pack…), skipped as git does. */
  readonly skipped: { pack: string; error: string }[];
}

const OID = /^[0-9a-f]{40}$/;

/** `objectsDir` is the repository's objects directory (e.g. "/.git/objects"). */
export async function openObjectDatabase(
  files: FilesApi,
  objectsDir: string,
  opts: PackReaderOptions = {},
): Promise<ObjectDatabase> {
  const dir = objectsDir.replace(/\/+$/, "");
  const loose = gitObjects(filesStagingStore(files, dir));
  const packs: PackReader[] = [];
  const db: ObjectDatabase = {
    skipped: [],
    async get(oid, o) {
      if (!OID.test(oid)) return undefined;
      // A copy that fails (a corrupt entry, a bad delta) is passed over for the next pack, then
      // the loose objects, as git's find_pack_entry/mark_bad_packed_object do; the first error is
      // raised only when no other copy exists. This covers errors raised before `get` returns
      // (deltas, headers); a streamed whole object fails while it is read, past this point.
      let failed: unknown;
      for (const p of packs) {
        if (!p.has(oid)) continue;
        try {
          return await p.get(oid, o);
        } catch (e) {
          if (!(e instanceof PackError)) throw e;
          failed ??= e;
        }
      }
      const fromLoose = await loose.get(oid, { verify: o?.verify });
      if (fromLoose || !failed) return fromLoose;
      throw failed;
    },
    async entry(oid) {
      if (!OID.test(oid)) return undefined;
      for (const p of packs) if (p.has(oid)) return p.entry(oid);
      return undefined;
    },
    async has(oid) {
      if (!OID.test(oid)) return false;
      return packs.some((p) => p.has(oid)) || (await loose.has(oid));
    },
    async *list() {
      const seen = new Set<string>();
      for (const p of packs) {
        for (const id of p.ids()) {
          if (!seen.has(id)) {
            seen.add(id);
            yield id;
          }
        }
      }
      for await (const id of loose.list()) {
        if (!seen.has(id)) {
          seen.add(id);
          yield id;
        }
      }
    },
  };
  const maxObjectSize = opts.maxObjectSize ?? 2 ** 30;
  const externalBase = async (oid: string, visiting: Set<string>) => {
    const o = await db.get(oid, { visiting });
    if (!o) return undefined;
    // A loose base is not bounded by its pack's limit: check its declared size before buffering
    // it (a loose zlib bomb of a few hundred KB can declare hundreds of MiB).
    if (o.size > maxObjectSize)
      throw new PackError(
        `REF_DELTA base ${oid} is ${o.size} bytes, over the limit of ${maxObjectSize}`,
      );
    const parts: Uint8Array[] = [];
    for await (const c of o.content) parts.push(c);
    const data = new Uint8Array(o.size);
    let off = 0;
    for (const p of parts) {
      data.set(p, off);
      off += p.length;
    }
    return { type: o.type, data };
  };
  const names: string[] = [];
  for await (const e of files.list(`${dir}/pack`)) {
    const name =
      (e as { name?: string; path: string }).name ?? e.path.slice(e.path.lastIndexOf("/") + 1);
    if (/^pack-[0-9a-f]{40}\.idx$/.test(name)) names.push(name.slice(0, -4));
  }
  for (const base of names.sort()) {
    if (!(await files.exists(`${dir}/pack/${base}.pack`))) continue; // an idx without its pack is ignored
    try {
      packs.push(
        await openPack(files, `${dir}/pack/${base}.pack`, `${dir}/pack/${base}.idx`, {
          ...opts,
          externalBase,
        }),
      );
    } catch (e) {
      // git warns and skips a pack it cannot use; the healthy packs and loose objects stay readable
      db.skipped.push({ pack: base, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return db;
}
