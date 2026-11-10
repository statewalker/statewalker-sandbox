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
      for (const p of packs) {
        if (p.has(oid)) return p.get(oid, o);
      }
      return loose.get(oid, { verify: o?.verify });
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
  const externalBase = async (oid: string, visiting: Set<string>) => {
    const o = await db.get(oid, { visiting });
    if (!o) return undefined;
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
