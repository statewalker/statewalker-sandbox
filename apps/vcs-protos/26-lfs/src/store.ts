/**
 * X10a — the LFS object store on any FilesApi, in git-lfs's own layout under the repository root
 * (`lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>`): native git-lfs in a git-files repository reads what
 * we store and we read what it stored. Every write is streamed into `lfs/tmp/`, hashed (SHA-256)
 * and counted on the way, and renamed into place only when it matches what was expected — no
 * object becomes visible unverified, and a rename that fails is a failure. An interrupted download
 * keeps its bytes as parts under `lfs/incomplete/<oid>/`, each named by its offset and written so
 * that a failing source still leaves what arrived, on every backend. Parts may arrive in any order
 * (X12's chunked transfers): the held ranges are those of parts that overlap no earlier part; a
 * sequential download resumes from the run held from offset 0; completion needs the whole object
 * covered. One
 * download per object at a time within a process (`exclusive`); a failed verification drops the
 * parts, any other failure keeps them for the next attempt.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { createSha256, toHex } from "../../03-sha256-blake3/src/hashes.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { encodePointer, type Pointer, parsePointer } from "./pointer.js";

export interface LfsStore {
  has(oid: string): Promise<boolean>;
  size(oid: string): Promise<number | undefined>;
  read(oid: string, opts?: { start?: number; signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  /** streamed, verified (SHA-256, and size when given), then visible; `maxSize` bounds it */
  put(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    expect?: { oid: string; size?: number },
    opts?: { maxSize?: number },
  ): Promise<Pointer>;
  /** bytes held for an interrupted download */
  incomplete: {
    size(oid: string): Promise<number>;
    append(oid: string, source: AsyncIterable<Uint8Array>): Promise<number>;
    /** the byte ranges held, [start, end) each, sorted and disjoint (X12) */
    ranges(oid: string): Promise<[number, number][]>;
    /** writes a part at `offset` (bytes that arrived stay if the source fails) (X12) */
    write(oid: string, offset: number, source: AsyncIterable<Uint8Array>): Promise<number>;
    /** verifies what is held and makes it visible */
    complete(expect: Pointer): Promise<void>;
    remove(oid: string): Promise<void>;
    /** runs `fn` with no other `exclusive` call on the same object in this process */
    exclusive<T>(oid: string, fn: () => Promise<T>): Promise<T>;
  };
}

export class LfsVerifyError extends Error {
  override name = "ObjectIdMismatchError";
}
export class LfsTooLargeError extends Error {
  override name = "LfsTooLargeError";
}

/** per FilesApi, per object: the tail of the queue of `exclusive` calls */
const queues = new WeakMap<FilesApi, Map<string, Promise<unknown>>>();

const OID = /^[0-9a-f]{64}$/;
const randomId = () => toHex(crypto.getRandomValues(new Uint8Array(8)));

export function lfsStore(files: FilesApi, root: string): LfsStore {
  const at = (p: string) => (root ? `${root}/${p}` : p);
  const objectPath = (oid: string) => {
    if (!OID.test(oid)) throw new Error(`invalid lfs oid ${JSON.stringify(oid)}`);
    return at(`lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`);
  };
  const partsDir = (oid: string) => {
    if (!OID.test(oid)) throw new Error(`invalid lfs oid ${JSON.stringify(oid)}`);
    return at(`lfs/incomplete/${oid}`);
  };
  const allParts = async (oid: string) => {
    const dir = partsDir(oid);
    if (!(await files.exists(dir))) return [];
    const out: { path: string; offset: number; size: number }[] = [];
    for await (const e of files.list(dir)) {
      if (e.kind !== "file") continue;
      const offset = Number(e.name);
      const st = await files.stats(`${dir}/${e.name}`);
      if (Number.isSafeInteger(offset) && st?.kind === "file")
        out.push({ path: `${dir}/${e.name}`, offset, size: st.size });
    }
    return out.sort((a, b) => a.offset - b.offset);
  };
  /**
   * The parts that overlap no earlier one (empty ones aside), merged into the held ranges; the
   * contiguous run from offset 0 (`end`: what a sequential download resumes from); the others.
   */
  const parts = async (oid: string) => {
    const kept: { path: string; offset: number; size: number }[] = [];
    const stray: string[] = [];
    let last = 0;
    for (const p of await allParts(oid)) {
      if (p.size > 0 && p.offset >= last) {
        kept.push(p);
        last = p.offset + p.size;
      } else stray.push(p.path);
    }
    const ranges: [number, number][] = [];
    for (const p of kept) {
      const r = ranges.at(-1);
      if (r && r[1] === p.offset) r[1] = p.offset + p.size;
      else ranges.push([p.offset, p.offset + p.size]);
    }
    const end = ranges[0]?.[0] === 0 ? ranges[0][1] : 0;
    const chain = kept.filter((p) => p.offset < end);
    return { kept, chain, stray, ranges, end };
  };
  /** a part at `offset`; a failing source ends the write normally (what arrived stays) */
  const writePart = async (oid: string, offset: number, source: AsyncIterable<Uint8Array>) => {
    let failure: unknown;
    let n = 0;
    async function* upTo() {
      try {
        for await (const c of source) {
          n += c.length;
          yield c;
        }
      } catch (e) {
        failure = e;
      }
    }
    await files.write(`${partsDir(oid)}/${String(offset).padStart(16, "0")}`, upTo());
    if (failure) throw failure;
    return n;
  };
  const size = async (oid: string) => {
    const st = await files.stats(objectPath(oid));
    return st?.kind === "file" ? (st.size ?? 0) : undefined;
  };
  const put: LfsStore["put"] = async (source, expect, opts = {}) => {
    const tmp = at(`lfs/tmp/${randomId()}`);
    const h = createSha256();
    let n = 0;
    async function* hashed() {
      for await (const c of source) {
        h.update(c);
        n += c.length;
        if (opts.maxSize !== undefined && n > opts.maxSize)
          throw new LfsTooLargeError(`lfs object over the limit of ${opts.maxSize} bytes`);
        if (expect?.size !== undefined && n > expect.size)
          throw new LfsVerifyError(`lfs object ${expect.oid}: more than its ${expect.size} bytes`);
        yield c;
      }
    }
    try {
      await files.write(tmp, hashed());
      const oid = toHex(h.digest());
      if (expect && (oid !== expect.oid || (expect.size !== undefined && n !== expect.size)))
        throw new LfsVerifyError(
          `lfs object hashed to ${oid} (${n} bytes), expected ${expect.oid} (${expect.size} bytes)`,
        );
      if (
        (await size(oid)) !== n &&
        !(await files.move(tmp, objectPath(oid))) &&
        (await size(oid)) !== n
      )
        throw new Error(`lfs object ${oid}: could not be moved into place`);
      await files.remove(tmp).catch(() => false);
      return { oid, size: n };
    } catch (e) {
      await files.remove(tmp).catch(() => false);
      throw e;
    }
  };
  const held = async (oid: string) => (await parts(oid)).end;
  return {
    has: async (oid) => OID.test(oid) && (await size(oid)) !== undefined,
    size,
    read: (oid, o = {}) => files.read(objectPath(oid), { start: o.start, signal: o.signal }),
    put,
    incomplete: {
      size: held,
      async append(oid, source) {
        // a sequential download: what lies past the run from 0 would overlap it, and goes
        const { end: offset, chain } = await parts(oid);
        const keep = new Set(chain.map((p) => p.path));
        for (const p of await allParts(oid))
          if (!keep.has(p.path)) await files.remove(p.path).catch(() => false);
        return writePart(oid, offset, source);
      },
      async complete(expect) {
        const { chain, end } = await parts(expect.oid);
        if (end < expect.size)
          throw new Error(`lfs object ${expect.oid}: ${end} of ${expect.size} bytes held`);
        async function* all() {
          for (const p of chain) yield* files.read(p.path);
        }
        try {
          await put(all(), expect);
        } catch (e) {
          // bytes that do not verify are dropped; a failure to read them is not theirs
          if (e instanceof LfsVerifyError)
            await files.remove(partsDir(expect.oid)).catch(() => false);
          throw e;
        }
        await files.remove(partsDir(expect.oid)).catch(() => false);
      },
      async remove(oid) {
        await files.remove(partsDir(oid)).catch(() => false);
      },
      ranges: async (oid) => (await parts(oid)).ranges,
      write: (oid, offset, source) => {
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new Error(`invalid part offset ${offset}`);
        return writePart(oid, offset, source);
      },
      async exclusive(oid, fn) {
        const byOid = queues.get(files) ?? new Map<string, Promise<unknown>>();
        queues.set(files, byOid);
        const key = `${root}\0${oid}`;
        const before = byOid.get(key) ?? Promise.resolve();
        const run = before.then(fn, fn);
        const tail = run.catch(() => undefined);
        byOid.set(key, tail);
        try {
          return await run;
        } finally {
          if (byOid.get(key) === tail) byOid.delete(key);
        }
      },
    },
  };
}

/** The store of a repository (its files and root: the .git directory, or the SQL store's files). */
export function repoLfsStore(repo: Repository): LfsStore {
  const access = repo.objects.gc;
  if (!access) throw new Error("this repository's store has no files for LFS objects");
  return lfsStore(access.files, access.root);
}

/** git lfs clean: the content stored, its pointer returned (an empty input is its own pointer) */
export async function clean(
  store: LfsStore,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<{ pointer: Uint8Array } & Pointer> {
  const p = await store.put(source);
  return { ...p, pointer: encodePointer(p) };
}

/**
 * git lfs smudge: a pointer's content (read from the blob's first 1024 bytes, as git-lfs does);
 * anything else (an empty blob included) unchanged
 */
export async function* smudge(store: LfsStore, blob: Uint8Array): AsyncGenerator<Uint8Array> {
  // git-lfs reads a pointer from the first MAX_POINTER_SIZE bytes, whatever follows them
  const p = parsePointer(blob);
  if (!p || p.size === 0) {
    yield blob;
    return;
  }
  const size = await store.size(p.oid);
  if (size === undefined) throw new Error(`lfs object ${p.oid} not found`);
  if (size !== p.size)
    throw new LfsVerifyError(`lfs object ${p.oid}: ${size} bytes, pointer says ${p.size}`);
  yield* store.read(p.oid);
}
