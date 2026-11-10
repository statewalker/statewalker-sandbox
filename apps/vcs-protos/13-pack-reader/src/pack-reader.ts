/**
 * X6r — reading objects from an installed pack, as git's packfile.c / JGit's Pack:
 *
 *  - open: the whole `.idx` v2 is read (28 bytes per object + 1 KiB) and validated — magic,
 *    version, monotonic fan-out, exact length (large-offset table included), its own SHA-1, and
 *    that the pack's trailer equals the pack checksum it records (a pack/idx mismatch is refused);
 *  - lookup: fan-out range + binary search over the sorted ids; 31-bit offsets or the 64-bit table;
 *  - entry bounds: the next offset in pack order (git's reverse index, built lazily), so every
 *    entry is read with one ranged read of exactly its bytes;
 *  - non-delta objects are streamed straight from the inflater (a 64 MiB blob never materialises);
 *    delta chains are walked down to a non-delta base or a cached object, then patched upwards
 *    with X6a's bounds-checked applier, every object on the way cached in a byte-bounded LRU
 *    (git's delta_base_cache);
 *  - `verify` re-hashes "type size\0" + content and fails at the end of the stream on mismatch.
 */
import { sha1 } from "@noble/hashes/legacy.js";
import type { FilesApi } from "@statewalker/webrun-files";
import type { ByteStream } from "@statewalker/webrun-storage";
import {
  createInflaterPool,
  type StreamInflater,
} from "../../04-pooled-inflater/src/pooled-inflater.js";
import { applyDelta, DeltaError } from "../../12-index-pack/src/delta.js";
import { PackError } from "../../12-index-pack/src/index-pack.js";

export { PackError };
export type ObjectTypeName = "commit" | "tree" | "blob" | "tag";
export interface ReadObject {
  type: ObjectTypeName;
  size: number;
  content: ByteStream;
}
export interface PackReaderOptions {
  /** Bytes of resolved delta bases kept across reads (git's delta_base_cache_limit). Default 16 MiB. */
  baseCacheBytes?: number;
  /** Resolves a REF_DELTA base that is not in this pack (another pack or a loose object). */
  externalBase?: (oid: string) => Promise<{ type: ObjectTypeName; data: Uint8Array } | undefined>;
}
export interface PackReader {
  readonly packId: string;
  readonly count: number;
  has(oid: string): boolean;
  /** Undefined when the pack does not contain `oid`. */
  get(oid: string, opts?: { verify?: boolean }): Promise<ReadObject | undefined>;
  ids(): Iterable<string>;
  /** Counters for tests: entry inflations performed. */
  readonly stats: { inflations: number };
}

const TYPES: Record<number, ObjectTypeName> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const SLICE = 1024;
const enc = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const hex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += HEX[x];
  return s;
};
const OID = /^[0-9a-f]{40}$/;
const oidBytes = (h: string) =>
  Uint8Array.from(h.match(/../g) as string[], (x) => Number.parseInt(x, 16));

async function readAll(
  files: FilesApi,
  path: string,
  start?: number,
  length?: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(path, start === undefined ? undefined : { start, length })) {
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

interface EntryHead {
  offset: number;
  kind: number;
  size: number;
  dataStart: number;
  end: number;
  baseOffset?: number;
  baseOid?: string;
}

export async function openPack(
  files: FilesApi,
  packPath: string,
  idxPath: string,
  opts: PackReaderOptions = {},
): Promise<PackReader> {
  const cacheLimit = opts.baseCacheBytes ?? 16 * 2 ** 20;
  // ---- idx
  const idx = await readAll(files, idxPath);
  if (idx.length < 8 + 1024 + 40) throw new PackError(`${idxPath}: idx too short`);
  const iv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
  if (iv.getUint32(0) !== 0xff744f63 || iv.getUint32(4) !== 2)
    throw new PackError(`${idxPath}: not an idx v2`);
  let prev = 0;
  for (let i = 0; i < 256; i++) {
    const f = iv.getUint32(8 + i * 4);
    if (f < prev) throw new PackError(`${idxPath}: fan-out not monotonic`);
    prev = f;
  }
  const n = prev;
  const oidsAt = 8 + 1024;
  const crcAt = oidsAt + n * 20;
  const offAt = crcAt + n * 4;
  const largeAt = offAt + n * 4;
  if (idx.length < largeAt + 40) throw new PackError(`${idxPath}: idx truncated`);
  let large = 0;
  for (let i = 0; i < n; i++) if (iv.getUint32(offAt + i * 4) & 0x80000000) large++;
  if (idx.length !== largeAt + large * 8 + 40)
    throw new PackError(`${idxPath}: idx length does not match its tables`);
  const body = idx.subarray(0, idx.length - 20);
  if (hex(sha1(body)) !== hex(idx.subarray(idx.length - 20)))
    throw new PackError(`${idxPath}: idx checksum mismatch`);
  const packId = hex(idx.subarray(idx.length - 40, idx.length - 20));
  // ---- pack
  const stats = await files.stats(packPath);
  if (stats?.kind !== "file" || stats.size < 32)
    throw new PackError(`${packPath}: missing or too short`);
  const packLen = stats.size;
  const trailer = hex(await readAll(files, packPath, packLen - 20, 20));
  if (trailer !== packId)
    throw new PackError(`${packPath}: trailer ${trailer} does not match the idx (${packId})`);
  const head = await readAll(files, packPath, 0, 12);
  const pv = new DataView(head.buffer, head.byteOffset, 12);
  if (String.fromCharCode(...head.subarray(0, 4)) !== "PACK" || ![2, 3].includes(pv.getUint32(4))) {
    throw new PackError(`${packPath}: not a pack`);
  }
  if (pv.getUint32(8) !== n)
    throw new PackError(`${packPath}: ${pv.getUint32(8)} objects, idx lists ${n}`);

  const offsetOf = (i: number): number => {
    const v = iv.getUint32(offAt + i * 4);
    if (!(v & 0x80000000)) return v;
    const li = v & 0x7fffffff;
    return iv.getUint32(largeAt + li * 8) * 2 ** 32 + iv.getUint32(largeAt + li * 8 + 4);
  };
  const find = (oid: string): number => {
    if (!OID.test(oid)) return -1;
    const key = oidBytes(oid);
    let lo = key[0] ? iv.getUint32(8 + ((key[0] as number) - 1) * 4) : 0;
    let hi = iv.getUint32(8 + (key[0] as number) * 4);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      let c = 0;
      const at = oidsAt + mid * 20;
      for (let k = 0; k < 20 && c === 0; k++) c = (idx[at + k] as number) - (key[k] as number);
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1;
      else hi = mid;
    }
    return -1;
  };
  let sorted: Float64Array | undefined;
  const endOf = (offset: number): number => {
    if (!sorted) {
      sorted = new Float64Array(n);
      for (let i = 0; i < n; i++) sorted[i] = offsetOf(i);
      sorted.sort();
    }
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((sorted[mid] as number) <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo < n ? (sorted[lo] as number) : packLen - 20;
  };

  const pool = createInflaterPool();
  const st = { inflations: 0 };
  const readHead = async (offset: number): Promise<EntryHead> => {
    const end = endOf(offset);
    if (offset < 12 || end <= offset)
      throw new PackError(`${packPath}: bad entry offset ${offset}`);
    const h = await readAll(files, packPath, offset, Math.min(32, end - offset));
    let p = 0;
    const byte = () => {
      if (p >= h.length) throw new PackError(`${packPath}: entry header at ${offset} truncated`);
      return h[p++] as number;
    };
    let b = byte();
    const kind = (b >> 4) & 7;
    let size = b & 0x0f;
    let mul = 16;
    while (b & 0x80) {
      b = byte();
      size += (b & 0x7f) * mul;
      mul *= 128;
    }
    const e: EntryHead = { offset, kind, size, dataStart: 0, end };
    if (kind === 6) {
      b = byte();
      let back = b & 0x7f;
      while (b & 0x80) {
        b = byte();
        back = (back + 1) * 128 + (b & 0x7f);
      }
      e.baseOffset = offset - back;
      if (back === 0 || e.baseOffset < 12)
        throw new PackError(`${packPath}: OFS_DELTA at ${offset} points outside`);
    } else if (kind === 7) {
      if (p + 20 > h.length) throw new PackError(`${packPath}: REF_DELTA at ${offset} truncated`);
      e.baseOid = hex(h.subarray(p, p + 20));
      p += 20;
    } else if (!TYPES[kind]) {
      throw new PackError(`${packPath}: bad object type ${kind} at ${offset}`);
    }
    e.dataStart = offset + p;
    return e;
  };
  /** Streams one entry's inflated data, checking its length and the exact end of the zlib stream. */
  async function* inflate(e: EntryHead): AsyncGenerator<Uint8Array> {
    st.inflations++;
    const inflater: StreamInflater = pool.acquire();
    let got = 0;
    let done = false;
    try {
      for await (const c of files.read(packPath, {
        start: e.dataStart,
        length: e.end - e.dataStart,
      })) {
        for (let at = 0; at < c.length && !done; at += SLICE) {
          let r: ReturnType<StreamInflater["push"]>;
          try {
            r = inflater.push(c.subarray(at, at + SLICE));
          } catch (err) {
            throw new PackError(`${packPath}: entry at ${e.offset}: ${(err as Error).message}`);
          }
          for (const x of r.out) {
            got += x.length;
            if (got > e.size)
              throw new PackError(
                `${packPath}: entry at ${e.offset} inflates past ${e.size} bytes`,
              );
            yield x;
          }
          done = r.done;
        }
        if (done) break;
      }
      if (!done || got !== e.size)
        throw new PackError(`${packPath}: entry at ${e.offset} is truncated or corrupt`);
    } finally {
      if (!done) {
        try {
          inflater.end();
        } catch {
          // reported above
        }
      }
    }
  }
  const inflateAll = async (e: EntryHead): Promise<Uint8Array> => {
    const out = new Uint8Array(e.size);
    let o = 0;
    for await (const x of inflate(e)) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  };

  // ---- delta base cache: offset → resolved object, LRU by insertion order, bounded by bytes
  const cache = new Map<number, { type: ObjectTypeName; data: Uint8Array }>();
  let cached = 0;
  const cacheGet = (off: number) => {
    const v = cache.get(off);
    if (v) {
      cache.delete(off);
      cache.set(off, v);
    }
    return v;
  };
  const cachePut = (off: number, v: { type: ObjectTypeName; data: Uint8Array }) => {
    if (v.data.length > cacheLimit || cache.has(off)) return;
    cache.set(off, v);
    cached += v.data.length;
    for (const [k, x] of cache) {
      if (cached <= cacheLimit) break;
      cache.delete(k);
      cached -= x.data.length;
    }
  };
  /** Resolves the object at `offset` to bytes: walk down to a base, patch upwards, cache on the way. */
  const resolve = async (
    offset: number,
    depth = 0,
  ): Promise<{ type: ObjectTypeName; data: Uint8Array }> => {
    const chain: EntryHead[] = [];
    let cur = offset;
    let base: { type: ObjectTypeName; data: Uint8Array } | undefined;
    for (let guard = 0; ; guard++) {
      if (guard > 10_000 || depth > 50)
        throw new PackError(`${packPath}: delta chain too deep at ${offset}`);
      const hit = cacheGet(cur);
      if (hit) {
        base = hit;
        break;
      }
      const e = await readHead(cur);
      if (TYPES[e.kind]) {
        base = { type: TYPES[e.kind] as ObjectTypeName, data: await inflateAll(e) };
        if (chain.length) cachePut(cur, base);
        break;
      }
      chain.push(e);
      if (e.baseOffset !== undefined) {
        cur = e.baseOffset;
        continue;
      }
      const i = find(e.baseOid as string);
      if (i >= 0) {
        cur = offsetOf(i);
        continue;
      }
      base = await opts.externalBase?.(e.baseOid as string);
      if (!base) throw new PackError(`${packPath}: REF_DELTA base ${e.baseOid} not found`);
      break;
    }
    // Checkpoints, not every step: caching each object on the way would let the top of the last
    // chain evict everything else. Spread the cache's slots evenly along this chain (and keep the
    // object asked for), so the next request into the same chain stops at a nearby checkpoint.
    let data = base.data;
    const slots = Math.max(1, Math.floor(cacheLimit / Math.max(1, data.length)));
    const stride = Math.max(1, Math.ceil(chain.length / slots));
    for (let k = chain.length - 1; k >= 0; k--) {
      const e = chain[k] as EntryHead;
      try {
        data = applyDelta(data, await inflateAll(e));
      } catch (err) {
        if (err instanceof DeltaError)
          throw new PackError(`${packPath}: delta at ${e.offset}: ${err.message}`);
        throw err;
      }
      if (k === 0 || (chain.length - k) % stride === 0)
        cachePut(e.offset, { type: base.type, data });
    }
    return { type: base.type, data };
  };
  async function* verified(
    oid: string,
    type: ObjectTypeName,
    size: number,
    src: AsyncIterable<Uint8Array>,
  ) {
    const h = sha1.create().update(enc.encode(`${type} ${size}\0`));
    for await (const c of src) {
      h.update(c);
      yield c;
    }
    const got = hex(h.digest());
    if (got !== oid) throw new PackError(`${packPath}: object ${oid} hashes to ${got}`);
  }
  async function* once(b: Uint8Array) {
    yield b;
  }

  return {
    packId,
    count: n,
    stats: st,
    has: (oid) => find(oid) >= 0,
    *ids() {
      for (let i = 0; i < n; i++) yield hex(idx.subarray(oidsAt + i * 20, oidsAt + i * 20 + 20));
    },
    async get(oid, o) {
      const i = find(oid);
      if (i < 0) return undefined;
      const offset = offsetOf(i);
      let type: ObjectTypeName;
      let size: number;
      let content: AsyncIterable<Uint8Array>;
      const hit = cacheGet(offset);
      if (hit) {
        ({ type } = hit);
        size = hit.data.length;
        content = once(hit.data);
      } else {
        const e = await readHead(offset);
        if (TYPES[e.kind]) {
          // non-delta: streamed, never materialised
          type = TYPES[e.kind] as ObjectTypeName;
          size = e.size;
          content = inflate(e);
        } else {
          const r = await resolve(offset);
          type = r.type;
          size = r.data.length;
          content = once(r.data);
        }
      }
      return { type, size, content: o?.verify ? verified(oid, type, size, content) : content };
    },
  };
}
