/**
 * X6b1 — index-pack over FilesApi, evolved from X6a (12-index-pack) after git's
 * builtin/index-pack.c:
 *
 *   0. the incoming stream is stored as `<packDir>/tmp_pack_*` (refused at its first 12 bytes if it
 *      is not a pack, bounded by `maxPackSize`);
 *   1. one sequential pass: entry headers, delta bases, every zlib stream inflated once (stopping
 *      past the declared size), CRC-32 per entry, ids of non-delta objects, the trailer;
 *   2. deltas resolved depth first from each base, through a byte-bounded base cache; entries are
 *      re-read through a bounded window over the stored pack (one storage read serves many);
 *   3. thin packs (`externalBase` given, git's `--fix-thin`): every REF_DELTA still unresolved,
 *      in pack order, has its base looked up once, verified (its content must hash to the id),
 *      appended as a whole object and its subtree resolved; the pack is then rewritten with the
 *      new entry count and trailer (git's fixup_pack_header_footer);
 *   4. `.idx` v2; the pack is renamed into place first, the idx last.
 *
 * Per-entry state lives in typed arrays (about 80 bytes an entry, against ~0.9 KB of objects and
 * maps in X6a), so 200 000 objects fit in a Durable Object. Any failure removes every temporary.
 */
import { sha1 } from "@noble/hashes/legacy.js";
import type { FilesApi } from "@statewalker/webrun-files";
import { Deflate } from "pako";
import {
  createInflaterPool,
  type StreamInflater,
} from "../../04-pooled-inflater/src/pooled-inflater.js";
import { CRC_INIT, crc32Update, crcFinal } from "../../12-index-pack/src/crc32.js";
import { applyDelta, DeltaError } from "../../12-index-pack/src/delta.js";

export class PackError extends Error {
  override name = "PackError";
}

export type ObjectTypeName = "commit" | "tree" | "blob" | "tag";

/** Looks up an object the receiver already has (a thin pack's missing REF_DELTA base). */
export type ExternalBase = (
  oid: string,
) => Promise<{ type: ObjectTypeName; data: Uint8Array } | undefined>;

export interface IndexedEntry {
  oid: string;
  offset: number;
  crc32: number;
  type: ObjectTypeName;
  size: number;
}

export interface InstallOptions {
  /** Largest object (or delta) accepted, by its header. Default 1 GiB. */
  maxObjectSize?: number;
  /** Bytes of resolved bases kept while resolving deltas; evicted bases are re-derived. Default 32 MiB. */
  baseCacheBytes?: number;
  /** Largest pack accepted, enforced while it is stored (git's `receive.maxInputSize`). Default: none. */
  maxPackSize?: number;
  /** Completes thin packs from the local repository (git's `--fix-thin`). Without it they are refused. */
  externalBase?: ExternalBase;
  /** Size of the window phase 2 reads the stored pack through. Default 1 MiB. */
  windowBytes?: number;
}

export interface InstallResult {
  /** hex SHA-1 of the installed pack (its trailer); files are pack-<packId>.pack / .idx */
  packId: string;
  /** objects in the installed pack (received + appended bases) */
  count: number;
  idx: Uint8Array;
  /** Materialised on first access only (an object per entry). */
  readonly entries: IndexedEntry[];
  stats: {
    /** bases appended to complete a thin pack */
    appended: number;
    /** storage reads after the phase-1 pass (phase 2, thin completion) */
    storageReads: number;
    /** entries inflated again in phase 2 (bases and deltas) */
    deltaLoads: number;
  };
}

const TYPE_NAMES: (ObjectTypeName | undefined)[] = [undefined, "commit", "tree", "blob", "tag"];
const TYPE_CODE: Record<ObjectTypeName, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;
const SLICE = 1024; // inflater input per push: one push yields at most ~1 MiB (X4)
/** smallest possible entry: a 1-byte header and an 8-byte zlib stream (empty, fixed block) */
const MIN_ENTRY = 9;
const enc = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const hex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += HEX[x];
  return s;
};
const unhex = (h: string) => {
  // by character codes: a regex and a parseInt per byte were a measured cost on hot paths
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const a = h.charCodeAt(2 * i);
    const b = h.charCodeAt(2 * i + 1);
    out[i] = ((a <= 57 ? a - 48 : (a | 32) - 87) << 4) | (b <= 57 ? b - 48 : (b | 32) - 87);
  }
  return out;
};

/**
 * Struct-of-arrays entry table. Entries are in pack order (offsets ascending), appended bases
 * after the received ones; entry i ends where entry i+1 starts (the last at `dataEnd`).
 */
class Entries {
  n = 0;
  offset: Float64Array;
  size: Float64Array; // inflated size of the entry data (object or delta)
  objSize: Float64Array; // resolved object size
  crc: Uint32Array;
  /** OFS: base entry (phase 1); REF: the entry it was resolved against; -1 for whole objects */
  base: Int32Array;
  kind: Uint8Array; // 1-4, 6, 7
  type: Uint8Array; // resolved type 1-4, 0 while unresolved
  hdr: Uint8Array; // header length: data starts at offset + hdr
  oid: Uint8Array; // 20 bytes per entry, once resolved
  refOid: Uint8Array; // 20 bytes per entry, REF_DELTA base ids
  constructor(public cap: number) {
    this.offset = new Float64Array(cap);
    this.size = new Float64Array(cap);
    this.objSize = new Float64Array(cap);
    this.crc = new Uint32Array(cap);
    this.base = new Int32Array(cap);
    this.kind = new Uint8Array(cap);
    this.type = new Uint8Array(cap);
    this.hdr = new Uint8Array(cap);
    this.oid = new Uint8Array(cap * 20);
    this.refOid = new Uint8Array(cap * 20);
  }
  /** Room for `more` entries beyond `n`. */
  reserve(more: number) {
    if (this.n + more > this.cap) this.growTo(this.n + more);
  }
  /** Reallocates every array to `cap` entries, one array at a time (transient: one array). */
  growTo(cap: number) {
    if (cap <= this.cap) return;
    const g = <T extends Float64Array | Uint32Array | Int32Array | Uint8Array>(a: T, w = 1): T => {
      const b = new (a.constructor as new (n: number) => T)(cap * w);
      b.set(a);
      return b;
    };
    this.offset = g(this.offset);
    this.size = g(this.size);
    this.objSize = g(this.objSize);
    this.crc = g(this.crc);
    this.base = g(this.base);
    this.kind = g(this.kind);
    this.type = g(this.type);
    this.hdr = g(this.hdr);
    this.oid = g(this.oid, 20);
    this.refOid = g(this.refOid, 20);
    this.cap = cap;
  }
  oidHex(i: number) {
    return hex(this.oid.subarray(i * 20, i * 20 + 20));
  }
  /** index of the entry at `offset`, or -1 (binary search over the first `n` entries) */
  at(offset: number): number {
    let lo = 0;
    let hi = this.n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const o = this.offset[mid] as number;
      if (o === offset) return mid;
      if (o < offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}

/** compares 20-byte ids a[ai*20..] and b[bi*20..] */
function cmpOid(a: Uint8Array, ai: number, b: Uint8Array, bi: number): number {
  const x = ai * 20;
  const y = bi * 20;
  for (let k = 0; k < 20; k++) {
    const d = (a[x + k] as number) - (b[y + k] as number);
    if (d) return d;
  }
  return 0;
}

/** Sequential reader over a stored file: tracks position, the pack hash and the entry CRC. */
class SequentialReader {
  pos = 0;
  crc = CRC_INIT;
  private chunk: Uint8Array = new Uint8Array(0);
  private at = 0;
  private readonly it: AsyncIterator<Uint8Array>;
  readonly hasher = sha1.create();
  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly hashedLength: number,
  ) {
    this.it = source[Symbol.asyncIterator]();
  }
  private consumed(bytes: Uint8Array) {
    this.crc = crc32Update(this.crc, bytes);
    const room = this.hashedLength - this.pos;
    if (room > 0) this.hasher.update(room >= bytes.length ? bytes : bytes.subarray(0, room));
    this.pos += bytes.length;
  }
  private async fill(): Promise<boolean> {
    while (this.at >= this.chunk.length) {
      const r = await this.it.next();
      if (r.done) return false;
      this.chunk = r.value;
      this.at = 0;
    }
    return true;
  }
  async byte(): Promise<number> {
    if (!(await this.fill())) throw new PackError(`pack truncated at ${this.pos}`);
    const b = this.chunk.subarray(this.at, this.at + 1);
    this.at++;
    this.consumed(b);
    return b[0] as number;
  }
  async bytes(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      if (!(await this.fill())) throw new PackError(`pack truncated at ${this.pos}`);
      const k = Math.min(n - o, this.chunk.length - this.at);
      const part = this.chunk.subarray(this.at, this.at + k);
      out.set(part, o);
      this.at += k;
      o += k;
      this.consumed(part);
    }
    return out;
  }
  async inflate(inflater: StreamInflater, sink: (out: Uint8Array) => void): Promise<void> {
    for (;;) {
      if (!(await this.fill()))
        throw new PackError(`pack truncated inside a zlib stream at ${this.pos}`);
      const slice = this.chunk.subarray(this.at, Math.min(this.chunk.length, this.at + SLICE));
      const r = inflater.push(slice);
      for (const o of r.out) sink(o);
      const used = r.done ? r.consumed : slice.length;
      this.consumed(slice.subarray(0, used));
      this.at += used;
      if (r.done) return;
    }
  }
  async atEnd(): Promise<boolean> {
    return !(await this.fill());
  }
  async close(): Promise<void> {
    await this.it.return?.();
  }
}

const endInflater = (inflater: StreamInflater) => {
  try {
    inflater.end();
  } catch {
    // an unfinished stream reports truncation on end(); the caller's error says more
  }
};

/** Phase 1: one pass over the stored pack. */
async function parse(files: FilesApi, path: string, packLen: number, maxObjectSize: number) {
  if (packLen < 32) throw new PackError("pack too short");
  const pool = createInflaterPool();
  const r = new SequentialReader(files.read(path), packLen - 20);
  try {
    return await parseWith(r, pool, packLen, maxObjectSize);
  } finally {
    await r.close();
  }
}

async function parseWith(
  r: SequentialReader,
  pool: ReturnType<typeof createInflaterPool>,
  packLen: number,
  maxObjectSize: number,
) {
  const head = await r.bytes(12);
  if (String.fromCharCode(...head.subarray(0, 4)) !== "PACK")
    throw new PackError("not a pack (bad signature)");
  const view = new DataView(head.buffer, head.byteOffset, 12);
  const version = view.getUint32(4);
  const count = view.getUint32(8);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  // before allocating per-entry state: the pack must be able to hold what its header declares
  if (count > Math.floor((packLen - 32) / MIN_ENTRY)) {
    throw new PackError(
      `pack declares ${count} entries, more than its ${packLen} bytes can hold (truncated?)`,
    );
  }
  // Tables start small and grow (capped at the declared count) as entries are parsed:
  // a header can claim up to (size - 32) / 9 entries, and only parsed entries earn memory.
  const t = new Entries(Math.min(count, 4096));
  for (let i = 0; i < count; i++) {
    if (i === t.cap) {
      // grow towards the count the bytes parsed so far predict (average entry size, +6%), but
      // by 1.25×–2× only: a garbage tail cannot make the prediction allocate for it
      const predicted = Math.ceil(((i * (packLen - 32)) / Math.max(1, r.pos - 12)) * 1.06);
      const next = Math.min(t.cap * 2, Math.max(Math.ceil(t.cap * 1.25), predicted));
      t.growTo(Math.min(count, next));
    }
    r.crc = CRC_INIT;
    const offset = r.pos;
    if (offset >= packLen - 20) throw new PackError(`entry ${i} starts inside the trailer`);
    let b = await r.byte();
    const kind = (b >> 4) & 7;
    if (!TYPE_NAMES[kind] && kind !== OFS_DELTA && kind !== REF_DELTA)
      throw new PackError(`bad object type ${kind} at ${offset}`);
    let size = b & 0x0f;
    let mul = 16;
    while (b & 0x80) {
      b = await r.byte();
      size += (b & 0x7f) * mul;
      mul *= 128;
      if (mul > 2 ** 53) throw new PackError(`object size overflow at ${offset}`);
    }
    if (size > maxObjectSize) {
      throw new PackError(
        `entry at ${offset} declares ${size} bytes, over the limit of ${maxObjectSize}`,
      );
    }
    t.offset[i] = offset;
    t.kind[i] = kind;
    t.size[i] = size;
    t.base[i] = -1;
    if (kind === OFS_DELTA) {
      b = await r.byte();
      let back = b & 0x7f;
      while (b & 0x80) {
        b = await r.byte();
        back = (back + 1) * 128 + (b & 0x7f);
        if (back > offset) break; // already before the pack start: refused below
      }
      const baseOffset = offset - back;
      t.n = i; // search only the entries before this one
      const bi = back === 0 || baseOffset < 12 ? -1 : t.at(baseOffset);
      if (bi < 0) {
        throw new PackError(`OFS_DELTA at ${offset} points to ${baseOffset}, not an earlier entry`);
      }
      t.base[i] = bi;
    } else if (kind === REF_DELTA) {
      t.refOid.set(await r.bytes(20), i * 20);
    }
    t.hdr[i] = r.pos - offset;
    const inflater = pool.acquire();
    let got = 0;
    const typeName = TYPE_NAMES[kind];
    const objHash = typeName
      ? sha1.create().update(enc.encode(`${typeName} ${size}\0`))
      : undefined;
    try {
      await r.inflate(inflater, (out) => {
        got += out.length;
        // stop at the first byte past the declared size: never inflate a bomb to its end
        if (got > size)
          throw new PackError(`entry at ${offset} inflates past its declared ${size} bytes`);
        objHash?.update(out);
      });
    } catch (err) {
      endInflater(inflater);
      if (err instanceof PackError) throw err;
      throw new PackError(`entry at ${offset}: ${(err as Error).message}`);
    }
    if (got !== size)
      throw new PackError(`entry at ${offset} inflates to ${got} bytes, header says ${size}`);
    t.crc[i] = crcFinal(r.crc);
    if (objHash) {
      t.oid.set(objHash.digest(), i * 20);
      t.type[i] = kind;
      t.objSize[i] = size;
    }
  }
  t.n = count;
  if (r.pos !== packLen - 20)
    throw new PackError(`${packLen - 20 - r.pos} unexpected bytes before the trailer`);
  const expected = hex(r.hasher.digest());
  const trailer = hex(await r.bytes(20));
  if (trailer !== expected)
    throw new PackError(`pack checksum mismatch: trailer ${trailer}, content ${expected}`);
  if (!(await r.atEnd())) throw new PackError("bytes after the pack trailer");
  return { t, packId: trailer, pool };
}

/**
 * Ranged reads through one bounded window: an entry that fits is served from the window, which is
 * refilled (one storage read of `windowBytes` from the entry on) when it misses; larger entries
 * are read directly.
 */
class WindowReader {
  reads = 0;
  private path = "";
  private start = 0;
  private buf: Uint8Array | null = null;
  constructor(
    private readonly files: FilesApi,
    private readonly windowBytes: number,
  ) {}
  async *range(
    path: string,
    fileEnd: number,
    start: number,
    length: number,
  ): AsyncGenerator<Uint8Array> {
    if (length > this.windowBytes / 2) {
      this.reads++;
      yield* this.files.read(path, { start, length });
      return;
    }
    const b = this.buf;
    if (
      !(b && path === this.path && start >= this.start && start + length <= this.start + b.length)
    ) {
      this.buf = null; // never hold two windows
      this.reads++;
      const want = Math.min(this.windowBytes, fileEnd - start);
      const nb = new Uint8Array(want);
      let o = 0;
      for await (const c of this.files.read(path, { start, length: want })) {
        if (o + c.length > want) throw new PackError(`${path} grew while reading`);
        nb.set(c, o);
        o += c.length;
      }
      if (o < length) throw new PackError(`${path} truncated at ${start + o}`);
      this.buf = nb.subarray(0, o);
      this.path = path;
      this.start = start;
    }
    const w = this.buf as Uint8Array;
    yield w.subarray(start - this.start, start - this.start + length);
  }
  release() {
    this.buf = null;
  }
}

/** Bytes [start, start + length) of the logical pack (received part, then appended entries). */
type RangeRead = (start: number, length: number) => AsyncIterable<Uint8Array>;

/** Inflates one entry's data (exactly `size` bytes). */
async function loadEntry(
  read: RangeRead,
  t: Entries,
  i: number,
  end: number,
  inflater: StreamInflater,
): Promise<Uint8Array> {
  const size = t.size[i] as number; // ≤ maxObjectSize, checked when the entry was parsed
  const offset = t.offset[i] as number;
  const dataStart = offset + (t.hdr[i] as number);
  const out = new Uint8Array(size);
  let o = 0;
  let done = false;
  try {
    for await (const c of read(dataStart, end - dataStart)) {
      for (let at = 0; at < c.length && !done; at += SLICE) {
        const r = inflater.push(c.subarray(at, at + SLICE));
        for (const x of r.out) {
          if (o + x.length > out.length) throw new PackError(`entry at ${offset} grew on re-read`);
          out.set(x, o);
          o += x.length;
        }
        done = r.done;
      }
    }
  } catch (err) {
    endInflater(inflater);
    throw err;
  }
  if (!done || o !== size) {
    endInflater(inflater);
    throw new PackError(`entry at ${offset} could not be re-read`);
  }
  return out;
}

/**
 * Phase 2 (and thin completion): resolution state shared by every root. Memory, as git's
 * index-pack (delta_base_cache_limit, prune_base_data / get_base_data):
 *  - a frame whose children are all taken is released BEFORE its last child is descended into,
 *    so a linear chain holds the current base and the new result, not the whole chain;
 *  - frames below the top keep their content only within `baseCacheBytes`; an evicted base is
 *    re-derived by following base links (`t.base`) to a cached frame or a whole object, and the
 *    bases rebuilt on the way are kept in their frames (git's get_base_data).
 * The stack itself is typed arrays (entry, type, child cursors: 17 bytes a level) and the frames'
 * contents one array slot each, so a 100 000-deep comb costs a few MiB, not an object per level.
 * Children are taken in X6a's order: REF children last-first, then OFS children last-first.
 */
/** heap bytes of a Uint8Array beyond its data (object + backing store header), counted in the budget */
const OBJECT_OVERHEAD = 96;

class Resolver {
  private readonly ofsHead: Int32Array; // last OFS child (in pack order) of an entry, -1 none
  private readonly ofsNext: Int32Array; // previous OFS child of the same base
  private readonly refs: Int32Array; // REF_DELTA entries sorted by (base id, position)
  private depthOf: Int32Array; // entry → its stack level, -1 when not on the stack
  private sI = new Int32Array(64);
  private sType = new Uint8Array(64);
  private sOfs = new Int32Array(64); // next OFS child to take, -1 none
  private sRef = new Int32Array(64); // next REF child position in `refs` (counting down)
  private sRefLo = new Int32Array(64); // first REF child position
  private readonly contents: (Uint8Array | null)[] = [];
  private depth = 0;
  private evictFrom = 0; // levels below this hold no content
  private held = 0;
  loads = 0;
  constructor(
    private readonly t: Entries,
    private readonly load: (i: number) => Promise<Uint8Array>,
    private readonly opts: { maxObjectSize: number; baseCacheBytes: number },
  ) {
    const n = t.n;
    this.ofsHead = new Int32Array(n).fill(-1);
    this.ofsNext = new Int32Array(n).fill(-1);
    this.depthOf = new Int32Array(n).fill(-1);
    let refCount = 0;
    for (let i = 0; i < n; i++) {
      if (t.kind[i] === OFS_DELTA) {
        const b = t.base[i] as number;
        this.ofsNext[i] = this.ofsHead[b] as number;
        this.ofsHead[b] = i;
      } else if (t.kind[i] === REF_DELTA) refCount++;
    }
    const refs = new Int32Array(refCount);
    let k = 0;
    for (let i = 0; i < n; i++) if (t.kind[i] === REF_DELTA) refs[k++] = i;
    refs.sort((a, b) => cmpOid(t.refOid, a, t.refOid, b) || a - b);
    this.refs = refs;
  }
  /** Distinct base ids of the REF_DELTAs still unresolved (an upper bound on appended bases). */
  distinctUnresolvedBases(): number {
    const t = this.t;
    let count = 0;
    let last = -1;
    for (const c of this.refs) {
      if (t.type[c]) continue;
      if (last < 0 || cmpOid(t.refOid, last, t.refOid, c) !== 0) count++;
      last = c;
    }
    return count;
  }
  /** [lo, hi) of the REF children of entry i (by its resolved id) */
  private refRange(i: number): [number, number] {
    const t = this.t;
    let lo = 0;
    let hi = this.refs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmpOid(t.refOid, this.refs[mid] as number, t.oid, i) < 0) lo = mid + 1;
      else hi = mid;
    }
    let end = lo;
    while (end < this.refs.length && cmpOid(t.refOid, this.refs[end] as number, t.oid, i) === 0)
      end++;
    return [lo, end];
  }
  private hasChildren(i: number): boolean {
    const [lo, hi] = this.refRange(i);
    return hi > lo || (i < this.ofsHead.length && (this.ofsHead[i] as number) >= 0);
  }
  private hasMore(d: number): boolean {
    return (this.sRef[d] as number) >= (this.sRefLo[d] as number) || (this.sOfs[d] as number) >= 0;
  }
  private nextChild(d: number): number {
    const r = this.sRef[d] as number;
    if (r >= (this.sRefLo[d] as number)) {
      this.sRef[d] = r - 1;
      return this.refs[r] as number;
    }
    const c = this.sOfs[d] as number;
    if (c >= 0) this.sOfs[d] = this.ofsNext[c] as number;
    return c;
  }
  private patch(base: Uint8Array, d: Uint8Array, at: number) {
    try {
      return applyDelta(base, d, this.opts.maxObjectSize);
    } catch (err) {
      // only format errors become PackError; anything else (e.g. allocation failure) is not ours
      if (err instanceof DeltaError) throw new PackError(`delta at ${at}: ${err.message}`);
      throw err;
    }
  }
  private async loadCounted(i: number) {
    this.loads++;
    return this.load(i);
  }
  private levelOf(i: number): number {
    return i < this.depthOf.length ? (this.depthOf[i] as number) : this.appendedLevel(i);
  }
  /** appended entries are only ever roots (level 0) */
  private appendedLevel(i: number): number {
    return this.depth > 0 && this.sI[0] === i ? 0 : -1;
  }
  private setContent(d: number, c: Uint8Array | null) {
    const old = this.contents[d];
    if (old) this.held -= old.length + OBJECT_OVERHEAD;
    this.contents[d] = c;
    if (c) {
      this.held += c.length + OBJECT_OVERHEAD;
      if (d < this.evictFrom) this.evictFrom = d;
    }
  }
  private evict() {
    for (let d = this.evictFrom; d < this.depth - 1 && this.held > this.opts.baseCacheBytes; d++) {
      if (this.contents[d]) this.setContent(d, null);
      this.evictFrom = d + 1;
    }
  }
  private push(i: number, type: number, content: Uint8Array) {
    const d = this.depth;
    if (d === this.sI.length) {
      const grow = <T extends Int32Array | Uint8Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.sI = grow(this.sI);
      this.sType = grow(this.sType);
      this.sOfs = grow(this.sOfs);
      this.sRef = grow(this.sRef);
      this.sRefLo = grow(this.sRefLo);
    }
    const [lo, hi] = this.refRange(i);
    this.sI[d] = i;
    this.sType[d] = type;
    this.sRefLo[d] = lo;
    this.sRef[d] = hi - 1;
    this.sOfs[d] = i < this.ofsHead.length ? (this.ofsHead[i] as number) : -1;
    if (i < this.depthOf.length) this.depthOf[i] = d;
    this.depth++;
    this.setContent(d, content);
    this.evict();
  }
  private pop() {
    const d = --this.depth;
    const i = this.sI[d] as number;
    if (i < this.depthOf.length) this.depthOf[i] = -1;
    this.setContent(d, null);
    this.contents.length = d;
    if (this.evictFrom > d) this.evictFrom = d;
  }
  private async derive(i: number): Promise<Uint8Array> {
    const t = this.t;
    const chain: number[] = [];
    let cur = i;
    let content: Uint8Array | undefined;
    for (;;) {
      const lv = this.levelOf(cur);
      const c = lv >= 0 ? this.contents[lv] : null;
      if (c) {
        content = c;
        break;
      }
      if (t.kind[cur] !== OFS_DELTA && t.kind[cur] !== REF_DELTA) {
        content = await this.loadCounted(cur);
        break;
      }
      chain.push(cur);
      cur = t.base[cur] as number;
      if (cur < 0) throw new PackError(`cannot re-derive the base of the entry at ${t.offset[i]}`);
    }
    for (let k = chain.length - 1; k >= 0; k--) {
      const c = chain[k] as number;
      content = this.patch(content, await this.loadCounted(c), t.offset[c] as number);
      const lv = k > 0 ? this.levelOf(c) : -1;
      if (lv >= 0 && !this.contents[lv]) {
        this.setContent(lv, content);
        this.evict();
      }
    }
    return content;
  }
  /** Resolves every delta below the whole object `root` (content given, or loaded). */
  async resolveFrom(root: number, content?: Uint8Array): Promise<void> {
    const t = this.t;
    if (!this.hasChildren(root)) return;
    this.push(root, t.type[root] as number, content ?? (await this.loadCounted(root)));
    while (this.depth) {
      const d = this.depth - 1;
      const child = this.nextChild(d);
      if (child < 0) {
        this.pop();
        continue;
      }
      // Reachable again through a second base with the same id (a duplicate object). git 2.43
      // refuses such packs ("already resolved (duplicate base)"); current git accepts them and
      // so do we: the delta resolves to the same object.
      if (t.type[child]) continue;
      let base = this.contents[d] ?? null;
      if (!base) {
        base = await this.derive(this.sI[d] as number);
        this.setContent(d, base);
        this.evict();
      }
      const type = this.sType[d] as number;
      const result = this.patch(base, await this.loadCounted(child), t.offset[child] as number);
      const typeName = TYPE_NAMES[type] as ObjectTypeName;
      t.type[child] = type;
      t.objSize[child] = result.length;
      t.base[child] = this.sI[d] as number;
      t.oid.set(
        sha1
          .create()
          .update(enc.encode(`${typeName} ${result.length}\0`))
          .update(result)
          .digest(),
        child * 20,
      );
      if (!this.hasMore(d)) this.pop(); // release the parent before descending
      if (this.hasChildren(child)) this.push(child, type, result);
    }
  }
}

/** `.idx` version 2 over the first `n` entries of a table, laid out as git's write_idx_file. */
function writeIdxFrom(t: Entries, packId: string): Uint8Array {
  const n = t.n;
  // ties (duplicate objects) stay in pack order, as X6a's stable sort (git's qsort agrees on
  // every pack tested; see X6a)
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => cmpOid(t.oid, a, t.oid, b) || a - b);
  let large = 0;
  for (let i = 0; i < n; i++) if ((t.offset[i] as number) > 0x7fffffff) large++;
  const size = 8 + 256 * 4 + n * 20 + n * 4 + n * 4 + large * 8 + 40;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set([0xff, 0x74, 0x4f, 0x63], 0);
  v.setUint32(4, 2);
  const fan = new Uint32Array(256);
  for (let i = 0; i < n; i++) (fan[t.oid[i * 20] as number] as number)++;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += fan[i] as number;
    v.setUint32(8 + i * 4, acc);
  }
  let p = 8 + 1024;
  for (const i of order) {
    out.set(t.oid.subarray(i * 20, i * 20 + 20), p);
    p += 20;
  }
  for (const i of order) {
    v.setUint32(p, t.crc[i] as number);
    p += 4;
  }
  let li = 0;
  const largeAt: number[] = [];
  for (const i of order) {
    const off = t.offset[i] as number;
    if (off > 0x7fffffff) {
      v.setUint32(p, (0x80000000 | li++) >>> 0);
      largeAt.push(off);
    } else v.setUint32(p, off);
    p += 4;
  }
  for (const off of largeAt) {
    v.setUint32(p, Math.floor(off / 2 ** 32));
    v.setUint32(p + 4, off >>> 0);
    p += 8;
  }
  out.set(unhex(packId), p);
  p += 20;
  out.set(sha1(out.subarray(0, p)), p);
  return out;
}

/** `.idx` v2 for a list of entries (X6a's interface). */
export function writeIdx(entries: IndexedEntry[], packId: string): Uint8Array {
  const t = new Entries(entries.length);
  entries.forEach((e, i) => {
    t.oid.set(unhex(e.oid), i * 20);
    t.offset[i] = e.offset;
    t.crc[i] = e.crc32;
  });
  t.n = entries.length;
  return writeIdxFrom(t, packId);
}

/** pack entry header for a whole object */
function objectHeader(type: number, size: number): Uint8Array {
  const out: number[] = [];
  let b = (type << 4) | (size & 15);
  let s = Math.floor(size / 16);
  while (s) {
    out.push(b | 0x80);
    b = s & 127;
    s = Math.floor(s / 128);
  }
  out.push(b);
  return Uint8Array.from(out);
}

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => HEX[b]).join("");

async function* guardedPack(
  source: AsyncIterable<Uint8Array>,
  maxPackSize: number,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  let head = new Uint8Array(0);
  for await (const chunk of source) {
    total += chunk.length;
    if (total > maxPackSize) throw new PackError(`pack over the limit of ${maxPackSize} bytes`);
    if (head.length < 12) {
      const next = new Uint8Array(Math.min(12, head.length + chunk.length));
      next.set(head);
      next.set(chunk.subarray(0, next.length - head.length), head.length);
      head = next;
      if (head.length === 12) {
        const v = new DataView(head.buffer);
        if (v.getUint32(0) !== 0x5041434b) throw new PackError("not a pack: no PACK signature");
        const version = v.getUint32(4);
        if (version !== 2 && version !== 3)
          throw new PackError(`unsupported pack version ${version}`);
      }
    }
    yield chunk;
  }
}

/** Appended entries are batched: written to `tmp_thin_*` files of about this size. */
const BATCH = 2 ** 20;

/**
 * Appended entries, in offset order, as segments of the logical pack: written files of up to
 * BATCH bytes (an entry larger than BATCH gets a file of its own) and one in-memory batch being
 * filled. A fetch needing hundreds of bases writes a few files, not one per base.
 */
class AppendedStore {
  readonly segments: { start: number; length: number; path: string | null }[] = [];
  private buf: Uint8Array | null = null;
  private fill = 0;
  private k = 0;
  constructor(
    private readonly files: FilesApi,
    private readonly prefix: string,
    public end: number,
  ) {}
  get paths(): string[] {
    return this.segments.flatMap((g) => (g.path ? [g.path] : []));
  }
  /** Every path this store may have written or be writing (for cleanup on failure). */
  get allPaths(): string[] {
    return Array.from({ length: this.k }, (_, j) => `${this.prefix}${j}`);
  }
  async add(parts: Uint8Array[], total: number): Promise<void> {
    if (total > BATCH) {
      await this.flush();
      const path = `${this.prefix}${this.k++}`;
      this.segments.push({ start: this.end, length: total, path });
      await this.files.write(path, parts);
      this.end += total;
      return;
    }
    if (this.fill + total > BATCH) await this.flush();
    if (!this.buf) this.buf = new Uint8Array(BATCH);
    if (this.fill === 0) this.segments.push({ start: this.end, length: 0, path: null });
    for (const x of parts) {
      this.buf.set(x, this.fill);
      this.fill += x.length;
    }
    (this.segments[this.segments.length - 1] as { length: number }).length += total;
    this.end += total;
  }
  async flush(): Promise<void> {
    if (this.fill === 0) return;
    const g = this.segments[this.segments.length - 1] as { path: string | null };
    const path = `${this.prefix}${this.k++}`;
    await this.files.write(path, [(this.buf as Uint8Array).subarray(0, this.fill)]);
    g.path = path;
    this.fill = 0;
  }
  release() {
    this.buf = null;
  }
  /** Bytes [start, start + length) of the appended part. */
  read(win: WindowReader, start: number, length: number): AsyncIterable<Uint8Array> {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((this.segments[mid]?.start as number) <= start) lo = mid;
      else hi = mid - 1;
    }
    const g = this.segments[lo] as { start: number; length: number; path: string | null };
    if (start + length > g.start + g.length)
      throw new PackError(`appended entry at ${start} crosses its segment`);
    if (g.path) return win.range(g.path, g.length, start - g.start, length);
    const at = start - g.start;
    const view = (this.buf as Uint8Array).subarray(at, at + length);
    return (async function* () {
      yield view;
    })();
  }
}

/** zlib (pako, level 6) of `data` as the deflater's own chunks: no concatenated copy. */
function deflateChunks(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const d = new Deflate();
  d.onData = (c: Uint8Array) => {
    out.push(c);
  };
  d.push(data, true);
  if (d.err) throw new Error(`deflate failed: ${d.msg}`);
  return out;
}

/**
 * Thin completion (git's fix_unresolved_deltas): REF_DELTAs still unresolved, in pack order; each
 * missing base id is looked up once (a miss is remembered), verified, appended as a pack entry (it
 * becomes entry n of the completed pack) and its subtree resolved at once, so a later delta on a
 * thin delta's result is already resolved. The table grows once, by the number of distinct
 * missing ids. `externalBase` should refuse objects over `maxObjectSize` itself: the data is
 * materialised before it can be checked here.
 */
async function completeThin(
  t: Entries,
  resolver: Resolver,
  externalBase: ExternalBase,
  store: AppendedStore,
  maxObjectSize: number,
) {
  const received = t.n;
  t.reserve(resolver.distinctUnresolvedBases());
  const misses = new Set<string>();
  for (let i = 0; i < received; i++) {
    if (t.kind[i] !== REF_DELTA || t.type[i]) continue;
    const oid = hex(t.refOid.subarray(i * 20, i * 20 + 20));
    if (misses.has(oid)) continue;
    const base = await externalBase(oid);
    if (!base) {
      misses.add(oid); // reported with the other unresolved deltas
      continue;
    }
    const code = TYPE_CODE[base.type];
    if (!code) throw new PackError(`base ${oid}: unknown type ${base.type}`);
    if (base.data.length > maxObjectSize)
      throw new PackError(`base ${oid} is larger than the limit of ${maxObjectSize}`);
    const id = hex(
      sha1
        .create()
        .update(enc.encode(`${base.type} ${base.data.length}\0`))
        .update(base.data)
        .digest(),
    );
    if (id !== oid) throw new PackError(`base ${oid} from the repository hashes to ${id}`);
    const parts = [objectHeader(code, base.data.length), ...deflateChunks(base.data)];
    let total = 0;
    let crc = CRC_INIT;
    for (const x of parts) {
      total += x.length;
      crc = crc32Update(crc, x);
    }
    const start = store.end;
    await store.add(parts, total);
    t.reserve(1);
    const k = t.n++;
    t.offset[k] = start;
    t.kind[k] = code;
    t.type[k] = code;
    t.size[k] = base.data.length;
    t.objSize[k] = base.data.length;
    t.hdr[k] = (parts[0] as Uint8Array).length;
    t.crc[k] = crcFinal(crc);
    t.base[k] = -1;
    t.oid.set(t.refOid.subarray(i * 20, i * 20 + 20), k * 20);
    await resolver.resolveFrom(k, base.data);
  }
  await store.flush();
}

/**
 * The completed pack: the received pack with the new entry count, then the appended entries, and
 * the SHA-1 of it all (git's fixup_pack_header_footer). The received part is re-hashed with its
 * original header on the way and must still match its trailer (the file did not change).
 */
async function* completedPack(
  files: FilesApi,
  tmpPack: string,
  receivedEnd: number,
  receivedTrailer: string,
  count: number,
  appended: string[],
  done: (packId: string) => void,
): AsyncGenerator<Uint8Array> {
  const h = sha1.create();
  const original = sha1.create();
  const head = new Uint8Array(12);
  let o = 0;
  for await (const c of files.read(tmpPack, { start: 0, length: 12 })) {
    head.set(c, o);
    o += c.length;
  }
  original.update(head);
  const fixed = head.slice();
  new DataView(fixed.buffer).setUint32(8, count);
  h.update(fixed);
  yield fixed;
  for await (const c of files.read(tmpPack, { start: 12, length: receivedEnd - 12 })) {
    original.update(c);
    h.update(c);
    yield c;
  }
  if (hex(original.digest()) !== receivedTrailer)
    throw new PackError("the stored pack changed while it was being completed");
  for (const path of appended) {
    for await (const c of files.read(path)) {
      h.update(c);
      yield c;
    }
  }
  const trailer = h.digest();
  done(hex(trailer));
  yield trailer;
}

export async function installPack(
  files: FilesApi,
  packDir: string,
  source: AsyncIterable<Uint8Array>,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const maxObjectSize = opts.maxObjectSize ?? 2 ** 30;
  const baseCacheBytes = opts.baseCacheBytes ?? 32 * 2 ** 20;
  const maxPackSize = opts.maxPackSize ?? Number.POSITIVE_INFINITY;
  const windowBytes = opts.windowBytes ?? 2 ** 20;
  const dir = packDir.replace(/\/+$/, "");
  const id = rand();
  const tmpPack = `${dir}/tmp_pack_${id}`;
  const tmpIdx = `${dir}/tmp_idx_${id}`;
  const tmpFixed = `${dir}/tmp_pack_${id}_fixed`;
  const win = new WindowReader(files, windowBytes);
  let appended: AppendedStore | undefined;
  try {
    await files.write(tmpPack, guardedPack(source, maxPackSize));
    const stats = await files.stats(tmpPack);
    if (stats?.kind !== "file") throw new PackError("pack was not stored");
    const parsed = await parse(files, tmpPack, stats.size, maxObjectSize);
    const t = parsed.t;
    const received = t.n;
    const dataEnd = stats.size - 20;
    appended = new AppendedStore(files, `${dir}/tmp_thin_${id}_`, dataEnd);
    const store = appended;
    const read: RangeRead = (start, length) =>
      start < dataEnd
        ? win.range(tmpPack, stats.size, start, length)
        : store.read(win, start, length);
    const endOf = (i: number) => {
      if (i + 1 < t.n) return t.offset[i + 1] as number;
      return i < received ? dataEnd : store.end;
    };
    const resolver = new Resolver(
      t,
      (i) => loadEntry(read, t, i, endOf(i), parsed.pool.acquire()),
      { maxObjectSize, baseCacheBytes },
    );
    for (let i = 0; i < received; i++)
      if (t.type[i] && t.kind[i] !== OFS_DELTA && t.kind[i] !== REF_DELTA)
        await resolver.resolveFrom(i);
    if (opts.externalBase) await completeThin(t, resolver, opts.externalBase, store, maxObjectSize);
    store.release();
    win.release();
    let missing = 0;
    let firstRef = -1;
    for (let i = 0; i < received; i++) {
      if (t.type[i]) continue;
      missing++;
      if (firstRef < 0 && t.kind[i] === REF_DELTA) firstRef = i;
    }
    if (missing) {
      throw new PackError(
        firstRef >= 0
          ? `${missing} unresolved deltas (thin pack? first missing base ${hex(t.refOid.subarray(firstRef * 20, firstRef * 20 + 20))})`
          : `${missing} deltas could not be resolved`,
      );
    }
    let packId = parsed.packId;
    let packFile = tmpPack;
    const appendedCount = t.n - received;
    if (appendedCount) {
      let fixedId = "";
      await files.write(
        tmpFixed,
        completedPack(files, tmpPack, dataEnd, parsed.packId, t.n, store.paths, (p) => {
          fixedId = p;
        }),
      );
      if (!fixedId) throw new PackError("the completed pack was not written");
      packId = fixedId;
      packFile = tmpFixed;
      await files.remove(tmpPack);
      for (const path of store.paths) await files.remove(path);
    }
    const idx = writeIdxFrom(t, packId);
    const result: InstallResult = {
      packId,
      count: t.n,
      idx,
      get entries() {
        const out: IndexedEntry[] = [];
        for (let i = 0; i < t.n; i++)
          out.push({
            oid: t.oidHex(i),
            offset: t.offset[i] as number,
            crc32: t.crc[i] as number,
            type: TYPE_NAMES[t.type[i] as number] as ObjectTypeName,
            size: t.objSize[i] as number,
          });
        Object.defineProperty(this, "entries", { value: out });
        return out;
      },
      stats: { appended: appendedCount, storageReads: win.reads, deltaLoads: resolver.loads },
    };
    const name = `${dir}/pack-${packId}`;
    if ((await files.exists(`${name}.pack`)) && (await files.exists(`${name}.idx`))) {
      // the same pack is already installed (a repeated fetch): keep it, as git does
      await files.remove(packFile);
      return result;
    }
    await files.write(tmpIdx, [idx]);
    if (!(await files.move(packFile, `${name}.pack`)))
      throw new Error(`could not move ${packFile}`);
    if (!(await files.move(tmpIdx, `${name}.idx`))) throw new Error(`could not move ${tmpIdx}`);
    return result;
  } catch (e) {
    win.release();
    appended?.release();
    for (const p of [tmpPack, tmpIdx, tmpFixed, ...(appended?.allPaths ?? [])])
      await files.remove(p).catch(() => false);
    throw e;
  }
}

/**
 * Removes `tmp_*` files in the pack directory last modified more than `olderThanMs` before `now`
 * (git prune's rule for `objects/pack/tmp_*`: an install interrupted by a crash or an evicted
 * Durable Object leaves them behind). Young temporaries may belong to an install in progress and
 * are kept. Returns the removed paths.
 */
export async function sweepPackTemporaries(
  files: FilesApi,
  packDir: string,
  opts: { olderThanMs: number; now?: number },
): Promise<string[]> {
  const dir = packDir.replace(/\/+$/, "");
  const limit = (opts.now ?? Date.now()) - opts.olderThanMs;
  const stale: string[] = [];
  for await (const e of files.list(dir)) {
    if (e.kind === "file" && e.name.startsWith("tmp_") && e.lastModified < limit)
      stale.push(`${dir}/${e.name}`);
  }
  const removed: string[] = [];
  for (const p of stale) if (await files.remove(p)) removed.push(p);
  return removed;
}
