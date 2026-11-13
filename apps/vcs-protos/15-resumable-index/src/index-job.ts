/**
 * X6b2 — index-pack as a resumable job, evolved from X6b1 (14-thin-packs): the same phases (store,
 * parse, resolve, complete a thin pack, write the idx, install), run in steps of bounded work.
 * Between steps nothing needs to stay in memory: each step commits a checkpoint to the pack
 * directory and the next one — in another request, another isolate — resumes from it.
 *
 * Checkpoints are log-structured: a step appends the entries it created or resolved (79 bytes
 * each) to a log segment, writes the resolver stack (17 bytes a level) when a subtree is in
 * progress, and commits by writing a new generation of the job state (JSON + its SHA-1; the
 * newest generation that verifies wins, so a crash mid-write falls back to the previous one).
 * Within a phase a step stops between units: an entry parsed, a delta resolved, a base looked up.
 * The pack checksum continues across steps through the exported SHA-1 state (sha1-state.ts).
 *
 * `installPack` runs the same machine to completion in one call without checkpoints (X6b1's
 * interface and results).
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
import { exportSha1, importSha1, type Sha1 } from "./sha1-state.js";

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
  readonly hasher: Sha1;
  /** `start`: absolute position of the source's first byte; `hasher`: the pack hash so far. */
  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly hashedLength: number,
    start = 0,
    hasher: Sha1 = sha1.create(),
  ) {
    this.it = source[Symbol.asyncIterator]();
    this.pos = start;
    this.hasher = hasher;
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

/**
 * Phase 1, one step: parses entries from `s.parse.pos` (entry `s.parse.i`) while the budget lasts,
 * continuing the pack checksum from its exported state. True once the trailer is verified.
 */
async function parseStep(
  files: FilesApi,
  path: string,
  s: JobState,
  t: Entries,
  budget: Budget,
  dirty: number[],
): Promise<boolean> {
  const packLen = s.packLen;
  const maxObjectSize = s.opts.maxObjectSize;
  if (packLen < 32) throw new PackError("pack too short");
  const pool = createInflaterPool();
  const r = new SequentialReader(
    s.parse.pos === 0
      ? files.read(path) // the whole pack, as X6b1 reads it
      : files.read(path, { start: s.parse.pos, length: packLen - s.parse.pos }),
    packLen - 20,
    s.parse.pos,
    importSha1(fromB64(s.parse.sha)),
  );
  try {
    if (s.parse.pos === 0) {
      const head = await r.bytes(12);
      if (String.fromCharCode(...head.subarray(0, 4)) !== "PACK")
        throw new PackError("not a pack (bad signature)");
      const view = new DataView(head.buffer, head.byteOffset, 12);
      const version = view.getUint32(4);
      const declared = view.getUint32(8);
      if (version !== 2 && version !== 3)
        throw new PackError(`unsupported pack version ${version}`);
      // before allocating per-entry state: the pack must be able to hold what its header declares
      if (declared > Math.floor((packLen - 32) / MIN_ENTRY)) {
        throw new PackError(
          `pack declares ${declared} entries, more than its ${packLen} bytes can hold (truncated?)`,
        );
      }
      s.count = declared;
      s.parse.pos = 12;
    }
    const count = s.count;
    for (let i = s.parse.i; i < count; i++) {
      if (!budget.take()) {
        s.parse.sha = toB64(exportSha1(r.hasher));
        return false;
      }
      if (i === t.cap) {
        // Tables grow (capped at the declared count) as entries are parsed, towards the count
        // the bytes parsed so far predict (average entry size, +6%), but by 1.25×–2× only: a
        // header can claim up to (size - 32) / 9 entries and only parsed entries earn memory.
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
          throw new PackError(
            `OFS_DELTA at ${offset} points to ${baseOffset}, not an earlier entry`,
          );
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
      t.n = i + 1;
      dirty.push(i);
      s.parse.i = i + 1;
      s.parse.pos = r.pos;
      s.n = i + 1;
    }
    if (r.pos !== packLen - 20)
      throw new PackError(`${packLen - 20 - r.pos} unexpected bytes before the trailer`);
    const expected = hex(r.hasher.digest());
    const trailer = hex(await r.bytes(20));
    if (trailer !== expected)
      throw new PackError(`pack checksum mismatch: trailer ${trailer}, content ${expected}`);
    if (!(await r.atEnd())) throw new PackError("bytes after the pack trailer");
    s.receivedPackId = trailer;
    s.parse.pos = packLen;
    return true;
  } finally {
    await r.close();
  }
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
  depth = 0;
  /** the table was grown for the thin completion's appended bases (once per resolver) */
  reserved = false;
  private evictFrom = 0; // levels below this hold no content
  private held = 0;
  loads = 0;
  constructor(
    private readonly t: Entries,
    /** how entries are read: rebound at every step (the window and the appended store are per step) */
    public load: (i: number) => Promise<Uint8Array>,
    private readonly opts: { maxObjectSize: number; baseCacheBytes: number },
    /** entries this resolver resolved, for the checkpoint log (rebound at every step) */
    public dirty: number[] = [],
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
  hasChildren(i: number): boolean {
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
  /** Starts the subtree of the whole object `root` (content given, or loaded); false if it has none. */
  async start(root: number, content?: Uint8Array): Promise<boolean> {
    if (!this.hasChildren(root)) return false;
    this.push(root, this.t.type[root] as number, content ?? (await this.loadCounted(root)));
    return true;
  }
  /** Resolves deltas of the subtree in progress, one budget unit each, until done or out of budget. */
  async run(budget: Budget): Promise<void> {
    const t = this.t;
    while (this.depth) {
      const d = this.depth - 1;
      if (!this.hasMore(d)) {
        this.pop();
        continue;
      }
      if (!budget.take()) return;
      const child = this.nextChild(d);
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
      this.dirty.push(child);
      if (!this.hasMore(d)) this.pop(); // release the parent before descending
      if (this.hasChildren(child)) this.push(child, type, result);
    }
  }
  /** The stack without contents: entry, type and child cursors per level (17 bytes a level). */
  snapshot(): Uint8Array {
    const out = new Uint8Array(4 + this.depth * 17);
    const v = new DataView(out.buffer);
    v.setUint32(0, this.depth);
    for (let d = 0; d < this.depth; d++) {
      const o = 4 + d * 17;
      v.setInt32(o, this.sI[d] as number);
      v.setInt32(o + 4, this.sOfs[d] as number);
      v.setInt32(o + 8, this.sRef[d] as number);
      v.setInt32(o + 12, this.sRefLo[d] as number);
      out[o + 16] = this.sType[d] as number;
    }
    return out;
  }
  /** Restores a snapshot; contents are re-derived on demand along the recorded base links. */
  restore(bytes: Uint8Array) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const depth = v.getUint32(0);
    if (bytes.length !== 4 + depth * 17) throw new PackError("corrupt resolver checkpoint");
    let cap = this.sI.length;
    while (cap < depth) cap *= 2;
    this.sI = new Int32Array(cap);
    this.sOfs = new Int32Array(cap);
    this.sRef = new Int32Array(cap);
    this.sRefLo = new Int32Array(cap);
    this.sType = new Uint8Array(cap);
    for (let d = 0; d < depth; d++) {
      const o = 4 + d * 17;
      const i = v.getInt32(o);
      this.sI[d] = i;
      this.sOfs[d] = v.getInt32(o + 4);
      this.sRef[d] = v.getInt32(o + 8);
      this.sRefLo[d] = v.getInt32(o + 12);
      this.sType[d] = bytes[o + 16] as number;
      if (i < this.depthOf.length) this.depthOf[i] = d;
    }
    this.depth = depth;
    this.contents.length = 0;
    for (let d = 0; d < depth; d++) this.contents.push(null);
    this.evictFrom = 0;
    this.held = 0;
  }
}

/** Work allowed in one step: units (entries, deltas, lookups) and a deadline. */
class Budget {
  used = 0;
  maxUnitMs = 0;
  private last: number;
  readonly started: number;
  constructor(
    private readonly units: number,
    private readonly deadline: number,
  ) {
    this.started = performance.now();
    this.last = this.started;
  }
  take(): boolean {
    const now = performance.now();
    if (this.used) this.maxUnitMs = Math.max(this.maxUnitMs, now - this.last);
    this.last = now;
    // the first unit is always granted: a step whose setup (a cold replay, rebuilding the
    // resolver) outlasts its budget must still progress, or the job livelocks
    if (this.used > 0 && (this.used >= this.units || now >= this.deadline)) return false;
    this.used++;
    return true;
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

interface Segment {
  start: number;
  length: number;
  path: string;
  /** the batch still being filled: rewritten at every checkpoint until it is full */
  open: boolean;
}

/**
 * Appended entries, in offset order, as segments of the logical pack: batches of up to BATCH bytes
 * (an entry larger than BATCH gets a file of its own). The batch being filled lives in memory and
 * is rewritten to its file at every checkpoint (`checkpoint()`) until it is full, so the files —
 * and the segment list in the job state — grow with the appended bytes, not with the steps.
 */
class AppendedStore {
  readonly segments: Segment[] = [];
  private buf: Uint8Array | null = null;
  private fill = 0;
  private k = 0;
  private constructor(
    private readonly files: FilesApi,
    private readonly prefix: string,
    public end: number,
  ) {}
  /** Restores the committed segments; the open batch is reloaded (up to its committed length). */
  static async open(
    files: FilesApi,
    prefix: string,
    end: number,
    segments: Segment[],
  ): Promise<AppendedStore> {
    const st = new AppendedStore(files, prefix, end);
    st.segments.push(...segments.map((g) => ({ ...g })));
    st.k = segments.length;
    const last = st.segments[st.segments.length - 1];
    if (last?.open) {
      st.buf = new Uint8Array(BATCH);
      let o = 0;
      for await (const c of files.read(last.path, { start: 0, length: last.length })) {
        st.buf.set(c.subarray(0, last.length - o), o);
        o += c.length;
      }
      if (o < last.length) throw new Error(`appended batch ${last.path} is torn`);
      st.fill = last.length;
    }
    return st;
  }
  get paths(): string[] {
    return this.segments.map((g) => g.path);
  }
  private get openSegment(): Segment | undefined {
    const last = this.segments[this.segments.length - 1];
    return last?.open ? last : undefined;
  }
  async add(parts: Uint8Array[], total: number): Promise<void> {
    if (total > BATCH) {
      await this.close();
      const path = `${this.prefix}${this.k++}`;
      this.segments.push({ start: this.end, length: total, path, open: false });
      await this.files.write(path, parts);
      this.end += total;
      return;
    }
    if (this.fill + total > BATCH) await this.close();
    if (!this.buf) this.buf = new Uint8Array(BATCH);
    let g = this.openSegment;
    if (!g) {
      g = { start: this.end, length: 0, path: `${this.prefix}${this.k++}`, open: true };
      this.segments.push(g);
    }
    for (const x of parts) {
      this.buf.set(x, this.fill);
      this.fill += x.length;
    }
    g.length += total;
    this.end += total;
  }
  /** Writes the open batch so far (it stays open). */
  async checkpoint(): Promise<void> {
    const g = this.openSegment;
    if (g) await this.files.write(g.path, [(this.buf as Uint8Array).subarray(0, this.fill)]);
  }
  /** Writes and closes the open batch. */
  async close(): Promise<void> {
    const g = this.openSegment;
    if (!g) return;
    await this.checkpoint();
    g.open = false;
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
    const g = this.segments[lo] as Segment;
    if (start + length > g.start + g.length)
      throw new PackError(`appended entry at ${start} crosses its segment`);
    if (!g.open) return win.range(g.path, g.length, start - g.start, length);
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
 * Thin completion (git's fix_unresolved_deltas), one step: REF_DELTAs still unresolved, in pack
 * order from `s.thin.i`; each missing base id is looked up once (one budget unit; a miss is
 * remembered), verified, appended as a pack entry and its subtree resolved at once, so a later
 * delta on a thin delta's result is already resolved. True when every REF_DELTA was visited.
 * `externalBase` should refuse objects over `maxObjectSize` itself: the data is materialised
 * before it can be checked here.
 */
async function thinStep(
  t: Entries,
  resolver: Resolver,
  externalBase: ExternalBase | undefined,
  store: AppendedStore,
  s: JobState,
  budget: Budget,
  dirty: number[],
): Promise<boolean> {
  if (!resolver.reserved) {
    t.reserve(resolver.distinctUnresolvedBases()); // an O(REF entries) scan: once, not per step
    resolver.reserved = true;
  }
  const misses = new Set(s.thin.misses);
  try {
    for (;;) {
      if (resolver.depth) {
        await resolver.run(budget);
        if (resolver.depth) return false;
      }
      while (s.thin.i < s.count && (t.kind[s.thin.i] !== REF_DELTA || t.type[s.thin.i])) s.thin.i++;
      if (s.thin.i >= s.count) return true;
      const i = s.thin.i;
      const oid = hex(t.refOid.subarray(i * 20, i * 20 + 20));
      if (!externalBase || misses.has(oid)) {
        s.thin.i++; // reported with the other unresolved deltas
        continue;
      }
      if (!budget.take()) return false;
      const base = await externalBase(oid);
      s.thin.i++;
      if (!base) {
        misses.add(oid);
        continue;
      }
      const code = TYPE_CODE[base.type];
      if (!code) throw new PackError(`base ${oid}: unknown type ${base.type}`);
      if (base.data.length > s.opts.maxObjectSize)
        throw new PackError(`base ${oid} is larger than the limit of ${s.opts.maxObjectSize}`);
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
      dirty.push(k);
      s.n = t.n;
      s.stats.appended++;
      await resolver.start(k, base.data);
    }
  } finally {
    s.thin.misses = [...misses];
  }
}

/** Phase 2, one step: subtrees of the received whole objects, in pack order from `s.nextRoot`. */
async function resolveStep(
  t: Entries,
  resolver: Resolver,
  s: JobState,
  budget: Budget,
): Promise<boolean> {
  for (;;) {
    if (resolver.depth) {
      await resolver.run(budget);
      if (resolver.depth) return false;
    }
    while (
      s.nextRoot < s.count &&
      !(
        t.type[s.nextRoot] &&
        t.kind[s.nextRoot] !== OFS_DELTA &&
        t.kind[s.nextRoot] !== REF_DELTA &&
        resolver.hasChildren(s.nextRoot)
      )
    )
      s.nextRoot++;
    if (s.nextRoot >= s.count) return true;
    if (!budget.take()) return false;
    await resolver.start(s.nextRoot++);
  }
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

interface JobOptions {
  maxObjectSize: number;
  baseCacheBytes: number;
  windowBytes: number;
}

/** Everything a step needs besides the entry table (which is replayed from the log). */
interface JobState {
  v: 1;
  id: string;
  /** generation of this state; checkpoint files of generation g are named ..._<g> */
  gen: number;
  phase: "parse" | "resolve" | "thin" | "finish" | "install" | "cleanup";
  packLen: number;
  /** entries declared by the received pack */
  count: number;
  /** entries in the table (received + appended) */
  n: number;
  receivedPackId: string;
  packId: string;
  packFile: string;
  opts: JobOptions;
  /**
   * The newest log segment (the generation that wrote it, its record count); each segment's
   * 8-byte header names the one before it, so the state stays the same size however many steps
   * the job takes.
   */
  log: { g: number; n: number } | null;
  /** generation of the resolver stack checkpoint, -1 when no subtree is in progress */
  stack: number;
  parse: { pos: number; i: number; sha: string };
  nextRoot: number;
  thin: {
    i: number;
    misses: string[];
    segments: Segment[];
    end: number;
  };
  stats: { storageReads: number; loads: number; appended: number };
}

export interface StepOptions {
  /** Units of work allowed: entries parsed, deltas resolved, bases looked up. Default: no limit. */
  units?: number;
  /** Wall-clock budget for the step's work (checked between units). Default: no limit. */
  budgetMs?: number;
  /** Completes thin packs (pass it to every step of a job that may need it). */
  externalBase?: ExternalBase;
  /** Ignore what this isolate still holds of the job and replay it from storage (tests). */
  cold?: boolean;
}

export type StepResult =
  | { done: false; phase: JobState["phase"]; units: number; workMs: number; maxUnitMs: number }
  | { done: true; result: InstallResult; units: number; workMs: number; maxUnitMs: number };

const RECORD = 79;
const toB64 = (b: Uint8Array) => {
  let x = "";
  for (let i = 0; i < b.length; i += 0x8000) x += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(x);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function jobPaths(dir: string, id: string) {
  return {
    pack: `${dir}/tmp_pack_${id}`,
    idx: `${dir}/tmp_idx_${id}`,
    fixed: `${dir}/tmp_pack_${id}_fixed`,
    thin: `${dir}/tmp_thin_${id}_`,
    jobPrefix: `tmp_job_${id}_`,
    state: (g: number) => `${dir}/tmp_job_${id}_state_${g}`,
    log: (g: number) => `${dir}/tmp_job_${id}_log_${g}`,
    stack: (g: number) => `${dir}/tmp_job_${id}_stack_${g}`,
  };
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(path)) {
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
 * The newest generation whose state verifies (0 for a job being started). A torn state file of a
 * crashed commit does not count: its retry rewrites it.
 */
async function newestGen(files: FilesApi, dir: string, id: string): Promise<number> {
  try {
    return (await loadState(files, dir, id)).gen;
  } catch (e) {
    if (e instanceof NoSuchJobError) return 0;
    throw e;
  }
}

/** The newest state generation whose content verifies (a torn write falls back to the previous). */
async function loadState(files: FilesApi, dir: string, id: string): Promise<JobState> {
  const prefix = `tmp_job_${id}_state_`;
  const gens: number[] = [];
  for await (const e of files.list(dir))
    if (e.kind === "file" && e.name.startsWith(prefix))
      gens.push(Number(e.name.slice(prefix.length)));
  gens.sort((a, b) => b - a);
  for (const g of gens) {
    const text = new TextDecoder().decode(await readAll(files, jobPaths(dir, id).state(g)));
    const cut = text.lastIndexOf("\n");
    if (cut < 0) continue;
    const json = text.slice(0, cut);
    if (hex(sha1(enc.encode(json))) !== text.slice(cut + 1)) continue;
    const st = JSON.parse(json) as JobState;
    if (st.v === 1 && st.id === id && st.gen === g) return st;
  }
  throw new NoSuchJobError(`no index job ${id} in ${dir}`);
}

function encodeRecords(t: Entries, indices: number[]): Uint8Array {
  const out = new Uint8Array(indices.length * RECORD);
  const v = new DataView(out.buffer);
  indices.forEach((i, k) => {
    const o = k * RECORD;
    v.setUint32(o, i);
    v.setFloat64(o + 4, t.offset[i] as number);
    v.setFloat64(o + 12, t.size[i] as number);
    v.setFloat64(o + 20, t.objSize[i] as number);
    v.setUint32(o + 28, t.crc[i] as number);
    v.setInt32(o + 32, t.base[i] as number);
    out[o + 36] = t.kind[i] as number;
    out[o + 37] = t.type[i] as number;
    out[o + 38] = t.hdr[i] as number;
    out.set(t.oid.subarray(i * 20, i * 20 + 20), o + 39);
    out.set(t.refOid.subarray(i * 20, i * 20 + 20), o + 59);
  });
  return out;
}

const LOG_HEADER = 8;

/** Rebuilds the entry table from the committed log segments (oldest first). */
async function replay(files: FilesApi, dir: string, s: JobState): Promise<Entries> {
  const t = new Entries(Math.max(s.n, 16));
  const paths = jobPaths(dir, s.id);
  // walk the chain back through the segment headers, then apply oldest first
  const chain: { g: number; n: number }[] = [];
  for (let cur = s.log; cur; ) {
    chain.unshift(cur);
    const st = await files.stats(paths.log(cur.g));
    // a missing or torn segment must not replay as zeros
    if (st?.kind !== "file" || st.size !== LOG_HEADER + cur.n * RECORD)
      throw new Error(`job log ${cur.g} is missing or torn`);
    const h = await readRange(files, paths.log(cur.g), 0, LOG_HEADER);
    const v = new DataView(h.buffer, h.byteOffset, LOG_HEADER);
    const pg = v.getInt32(0);
    cur = pg < 0 ? null : { g: pg, n: v.getUint32(4) };
  }
  for (const { g } of chain) {
    const all = await readAll(files, paths.log(g));
    const b = all.subarray(LOG_HEADER);
    const v = new DataView(b.buffer, b.byteOffset, b.length);
    for (let o = 0; o < b.length; o += RECORD) {
      const i = v.getUint32(o);
      if (i >= s.n) throw new PackError(`job log ${g} names entry ${i} of ${s.n}`);
      t.offset[i] = v.getFloat64(o + 4);
      t.size[i] = v.getFloat64(o + 12);
      t.objSize[i] = v.getFloat64(o + 20);
      t.crc[i] = v.getUint32(o + 28);
      t.base[i] = v.getInt32(o + 32);
      t.kind[i] = b[o + 36] as number;
      t.type[i] = b[o + 37] as number;
      t.hdr[i] = b[o + 38] as number;
      t.oid.set(b.subarray(o + 39, o + 59), i * 20);
      t.refOid.set(b.subarray(o + 59, o + 79), i * 20);
    }
  }
  t.n = s.n;
  return t;
}

async function readRange(files: FilesApi, path: string, start: number, length: number) {
  const out = new Uint8Array(length);
  let o = 0;
  for await (const c of files.read(path, { start, length })) {
    out.set(c.subarray(0, length - o), o);
    o += c.length;
  }
  if (o < length) throw new Error(`${path} is shorter than ${start + length} bytes`);
  return out;
}

/** Commits a step: its log segment, the resolver stack, then the next state generation. */
async function commit(
  files: FilesApi,
  dir: string,
  s: JobState,
  t: Entries,
  dirty: number[],
  stack: Uint8Array | null,
) {
  const paths = jobPaths(dir, s.id);
  const g = s.gen + 1;
  // compare-before-write: the job must still be at the generation this step started from
  const newest = await newestGen(files, dir, s.id);
  if (newest !== s.gen)
    throw new ConcurrentStepError(`job ${s.id} moved to generation ${newest} during this step`);
  const prevStack = s.stack;
  const prevGen = s.gen;
  const next: JobState = { ...s, gen: g, stack: -1 };
  if (dirty.length) {
    const header = new Uint8Array(LOG_HEADER);
    const hv = new DataView(header.buffer);
    hv.setInt32(0, s.log ? s.log.g : -1);
    hv.setUint32(4, s.log ? s.log.n : 0);
    await files.write(paths.log(g), [header, encodeRecords(t, dirty)]);
    next.log = { g, n: dirty.length };
  }
  if (stack) {
    await files.write(paths.stack(g), [stack]);
    next.stack = g;
  }
  const json = JSON.stringify(next);
  await files.write(paths.state(g), [enc.encode(`${json}\n${hex(sha1(enc.encode(json)))}`)]);
  Object.assign(s, next);
  // the new generation is durable: the previous state and stack are garbage
  await files.remove(paths.state(prevGen)).catch(() => false);
  if (prevStack >= 0) await files.remove(paths.stack(prevStack)).catch(() => false);
}

/**
 * Removes every temporary of a job. `strict` (a finished job): the state files go last and errors
 * propagate, so a failure leaves a job whose idempotent install step finishes the cleanup when
 * resumed; otherwise (an aborted job) best effort.
 */
async function removeJobFiles(files: FilesApi, dir: string, id: string, strict = false) {
  const names: string[] = [];
  for await (const e of files.list(dir))
    if (e.kind === "file" && e.name.startsWith("tmp_") && e.name.includes(id)) names.push(e.name);
  // state files last, oldest generation first: the newest state goes last, so a failure part-way
  // always leaves the newest state (the cleanup phase) to resume from — never an older one whose
  // logs are already gone (listing order would put state_10 before state_9)
  const gen = (n: string) => {
    const m = /_state_(\d+)$/.exec(n);
    return m ? Number(m[1]) : -1;
  };
  names.sort((x, y) => gen(x) - gen(y));
  for (const n of names) {
    if (strict) await files.remove(`${dir}/${n}`);
    else await files.remove(`${dir}/${n}`).catch(() => false);
  }
}

/** Tables this isolate still holds, by job: a warm step skips the replay. */
const warm = new Map<string, { gen: number; t: Entries; resolver?: Resolver }>();
/** At most this many jobs keep a warm table in an isolate (the least recently stepped go). */
const WARM_JOBS = 4;
/** Steps of a job in this isolate run one at a time (a DO's alarm and fetch can interleave). */
const running = new Map<string, Promise<void>>();

/**
 * Another stepper committed this job's next generation while this step ran (in another isolate:
 * within one isolate steps are serialized). The step's work is discarded; the job is intact.
 */
export class ConcurrentStepError extends Error {
  override name = "ConcurrentStepError";
}

/** No state for this job: it never existed, or it finished (its files are removed). */
export class NoSuchJobError extends Error {
  override name = "NoSuchJobError";
}

/** Results of jobs this isolate finished: a step queued behind the finishing one gets the result. */
const finished = new Map<string, StepResult>();

function newState(id: string, packLen: number, opts: InstallOptions): JobState {
  return {
    v: 1,
    id,
    gen: 0,
    phase: "parse",
    packLen,
    count: 0,
    n: 0,
    receivedPackId: "",
    packId: "",
    packFile: "",
    opts: {
      maxObjectSize: opts.maxObjectSize ?? 2 ** 30,
      baseCacheBytes: opts.baseCacheBytes ?? 32 * 2 ** 20,
      windowBytes: opts.windowBytes ?? 2 ** 20,
    },
    log: null,
    stack: -1,
    parse: { pos: 0, i: 0, sha: toB64(exportSha1(sha1.create())) },
    nextRoot: 0,
    thin: { i: 0, misses: [], segments: [], end: 0 },
    stats: { storageReads: 0, loads: 0, appended: 0 },
  };
}

/**
 * Stores the pack (`tmp_pack_<id>`: refused at its first 12 bytes if it is not a pack, bounded by
 * `maxPackSize`) and commits the job's first state. Returns the job id for `stepIndexJob`.
 */
export async function startIndexJob(
  files: FilesApi,
  packDir: string,
  source: AsyncIterable<Uint8Array>,
  opts: InstallOptions = {},
): Promise<string> {
  const dir = packDir.replace(/\/+$/, "");
  const id = rand();
  const paths = jobPaths(dir, id);
  try {
    await files.write(
      paths.pack,
      guardedPack(source, opts.maxPackSize ?? Number.POSITIVE_INFINITY),
    );
    const stats = await files.stats(paths.pack);
    if (stats?.kind !== "file") throw new PackError("pack was not stored");
    if (stats.size < 32) throw new PackError("pack too short");
    const s = newState(id, stats.size, opts);
    await commit(files, dir, s, new Entries(1), [], null);
    return id;
  } catch (e) {
    await removeJobFiles(files, dir, id);
    throw e;
  }
}

/**
 * The last phase: the pack and idx are installed; the job's temporaries go (a repeated fetch of
 * an installed pack keeps it, as git does). The result's idx is the installed file; `t` is absent
 * when a crash during a previous cleanup is being resumed (its logs may already be gone), and
 * then `entries` is not available.
 */
async function cleanup(
  files: FilesApi,
  dir: string,
  s: JobState,
  t: Entries | undefined,
  strict: boolean,
): Promise<InstallResult> {
  // the idx is the installed file: recomputed from the table when it is here (no read), read back
  // when a cleanup is resumed without it
  const idx = t ? writeIdxFrom(t, s.packId) : await readAll(files, `${dir}/pack-${s.packId}.idx`);
  if (idx.length < 8 + 1024) throw new Error(`installed ${s.packId}.idx is missing or short`);
  const count = new DataView(idx.buffer, idx.byteOffset).getUint32(8 + 255 * 4);
  await removeJobFiles(files, dir, s.id, strict);
  return {
    packId: s.packId,
    count,
    idx,
    get entries(): IndexedEntry[] {
      if (!t) throw new Error("entries are not available after a resumed cleanup: read the .idx");
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
    stats: {
      appended: s.stats.appended,
      storageReads: s.stats.storageReads,
      deltaLoads: s.stats.loads,
    },
  };
}

/** Runs phases while the budget lasts; returns the result once installed. */
async function advance(
  files: FilesApi,
  dir: string,
  s: JobState,
  t: Entries,
  budget: Budget,
  dirty: number[],
  externalBase: ExternalBase | undefined,
  persist: boolean,
  warmResolver?: Resolver,
): Promise<{
  result?: InstallResult;
  stack: Uint8Array | null;
  reads: number;
  resolver?: Resolver;
}> {
  const paths = jobPaths(dir, s.id);
  const win = new WindowReader(files, s.opts.windowBytes);
  let store: AppendedStore | undefined;
  let resolver: Resolver | undefined;
  const dataEnd = s.packLen - 20;
  const getResolver = async () => {
    if (resolver) return resolver;
    store = await AppendedStore.open(files, paths.thin, s.thin.end || dataEnd, s.thin.segments);
    const st = store;
    const read: RangeRead = (start, length) =>
      start < dataEnd
        ? win.range(paths.pack, s.packLen, start, length)
        : st.read(win, start, length);
    const endOf = (i: number) => {
      if (i + 1 < t.n) return t.offset[i + 1] as number;
      return i < s.count ? dataEnd : st.end;
    };
    const pool = createInflaterPool();
    const load = (i: number) => loadEntry(read, t, i, endOf(i), pool.acquire());
    if (warmResolver) {
      // the same isolate ran the previous step: keep its stack and cached bases
      resolver = warmResolver;
      resolver.load = load;
      resolver.dirty = dirty;
      return resolver;
    }
    resolver = new Resolver(
      t,
      load,
      { maxObjectSize: s.opts.maxObjectSize, baseCacheBytes: s.opts.baseCacheBytes },
      dirty,
    );
    resolver.loads = s.stats.loads;
    if (s.stack >= 0) resolver.restore(await readAll(files, paths.stack(s.stack)));
    return resolver;
  };
  const snapshot = () => (resolver?.depth ? resolver.snapshot() : null);
  try {
    for (;;) {
      if (s.phase === "parse") {
        if (!(await parseStep(files, paths.pack, s, t, budget, dirty))) break;
        s.phase = "resolve";
        continue;
      }
      if (s.phase === "resolve") {
        if (!(await resolveStep(t, await getResolver(), s, budget))) break;
        s.phase = "thin";
        continue;
      }
      if (s.phase === "thin") {
        const r = await getResolver();
        const finished = await thinStep(
          t,
          r,
          externalBase,
          store as AppendedStore,
          s,
          budget,
          dirty,
        );
        const st = store as AppendedStore;
        if (finished) await st.close();
        else await st.checkpoint();
        s.thin.segments = st.segments.map((g) => ({ ...g }));
        s.thin.end = st.end;
        if (!finished) break;
        s.phase = "finish";
        continue;
      }
      if (s.phase === "finish") {
        let missing = 0;
        let firstRef = -1;
        for (let i = 0; i < s.count; i++) {
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
        s.packId = s.receivedPackId;
        s.packFile = paths.pack;
        if (t.n > s.count) {
          let fixedId = "";
          await files.write(
            paths.fixed,
            completedPack(
              files,
              paths.pack,
              dataEnd,
              s.receivedPackId,
              t.n,
              s.thin.segments.map((g) => g.path),
              (p) => {
                fixedId = p;
              },
            ),
          );
          if (!fixedId) throw new PackError("the completed pack was not written");
          s.packId = fixedId;
          s.packFile = paths.fixed;
        }
        await files.write(paths.idx, [writeIdxFrom(t, s.packId)]);
        s.phase = "install";
        // the install moves files: commit first, so a crash during it never redoes the above
        if (persist) await commit(files, dir, s, t, dirty.splice(0), null);
        continue;
      }
      // install: idempotent, safe to repeat after a crash
      const name = `${dir}/pack-${s.packId}`;
      const installed = (await files.exists(`${name}.pack`)) && (await files.exists(`${name}.idx`));
      if (!installed) {
        if (await files.exists(s.packFile)) {
          if (!(await files.move(s.packFile, `${name}.pack`)))
            throw new Error(`could not move ${s.packFile}`);
        }
        if (!(await files.move(paths.idx, `${name}.idx`)))
          throw new Error(`could not move ${paths.idx}`);
      }
      s.stats.storageReads += win.reads;
      if (resolver) s.stats.loads = resolver.loads;
      s.phase = "cleanup";
      // the pack is installed: commit that, so a crash while removing the job's files (logs
      // among them) resumes into the cleanup, which needs nothing but the installed files
      if (persist) await commit(files, dir, s, t, [], null);
      return { result: await cleanup(files, dir, s, t, persist), stack: null, reads: 0 };
    }
    if (resolver) s.stats.loads = resolver.loads;
    return { stack: snapshot(), reads: win.reads, resolver };
  } finally {
    win.release();
    store?.release();
  }
}

/**
 * Runs one step of a job: at most `units` units of work and roughly `budgetMs` of wall time, then
 * commits a checkpoint. A storage failure leaves the job at its last checkpoint (resume by calling
 * again); a malformed pack (PackError) ends the job and removes its temporaries.
 */
export async function stepIndexJob(
  files: FilesApi,
  packDir: string,
  jobId: string,
  opts: StepOptions = {},
): Promise<StepResult> {
  const dir = packDir.replace(/\/+$/, "");
  const key = `${dir}|${jobId}`;
  const before = running.get(key);
  let release = () => {};
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const chained = (before ?? Promise.resolve()).then(() => mine);
  running.set(key, chained);
  await before;
  try {
    return await stepLocked(files, dir, key, jobId, opts);
  } finally {
    release();
    if (running.get(key) === chained) running.delete(key);
  }
}

function remember(key: string, r: StepResult): StepResult {
  finished.set(key, r);
  while (finished.size > WARM_JOBS) finished.delete(finished.keys().next().value as string);
  return r;
}

async function stepLocked(
  files: FilesApi,
  dir: string,
  key: string,
  jobId: string,
  opts: StepOptions,
): Promise<StepResult> {
  const done = finished.get(key);
  if (done) return done;
  const s = await loadState(files, dir, jobId);
  const cached = opts.cold ? undefined : warm.get(key);
  warm.delete(key); // re-added only after a successful commit
  const fresh = cached && cached.gen === s.gen ? cached : undefined;
  try {
    if (s.phase === "cleanup") {
      const result = await cleanup(files, dir, s, undefined, true);
      return remember(key, { done: true, result, units: 0, workMs: 0, maxUnitMs: 0 });
    }
    const t = fresh ? fresh.t : await replay(files, dir, s);
    // the budget covers the step's work, not the replay of a cold resume
    const budget = new Budget(
      opts.units ?? Number.POSITIVE_INFINITY,
      opts.budgetMs === undefined ? Number.POSITIVE_INFINITY : performance.now() + opts.budgetMs,
    );
    const dirty: number[] = [];
    const out = await advance(
      files,
      dir,
      s,
      t,
      budget,
      dirty,
      opts.externalBase,
      true,
      fresh?.resolver,
    );
    const workMs = performance.now() - budget.started;
    if (out.result)
      return remember(key, {
        done: true,
        result: out.result,
        units: budget.used,
        workMs,
        maxUnitMs: budget.maxUnitMs,
      });
    s.stats.storageReads += out.reads;
    await commit(files, dir, s, t, dirty, out.stack);
    warm.set(key, { gen: s.gen, t, resolver: out.resolver });
    while (warm.size > WARM_JOBS) warm.delete(warm.keys().next().value as string);
    return { done: false, phase: s.phase, units: budget.used, workMs, maxUnitMs: budget.maxUnitMs };
  } catch (e) {
    if (e instanceof PackError) await removeJobFiles(files, dir, jobId);
    throw e;
  }
}

/** X6b1's interface: the job run to completion in one call, without checkpoints. */
export async function installPack(
  files: FilesApi,
  packDir: string,
  source: AsyncIterable<Uint8Array>,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const dir = packDir.replace(/\/+$/, "");
  const id = rand();
  const paths = jobPaths(dir, id);
  try {
    await files.write(
      paths.pack,
      guardedPack(source, opts.maxPackSize ?? Number.POSITIVE_INFINITY),
    );
    const stats = await files.stats(paths.pack);
    if (stats?.kind !== "file") throw new PackError("pack was not stored");
    const s = newState(id, stats.size, opts);
    const out = await advance(
      files,
      dir,
      s,
      new Entries(4096),
      new Budget(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
      [],
      opts.externalBase,
      false,
    );
    return out.result as InstallResult;
  } catch (e) {
    await removeJobFiles(files, dir, id);
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
