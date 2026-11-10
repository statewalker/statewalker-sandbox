/**
 * X6a — index-pack over FilesApi, after git's builtin/index-pack.c and JGit's PackParser.
 *
 *   0. write the incoming stream to `<packDir>/tmp_pack_*` (streaming, nothing buffered);
 *   1. one sequential pass over the stored pack: entry headers, OFS/REF delta bases, every zlib
 *      stream inflated once (X1d's pooled push inflater, which reports the exact stream end), the
 *      CRC-32 of each entry's raw bytes, the id of every non-delta object (hashed while inflating,
 *      never retained), and the pack's SHA-1 trailer;
 *   2. delta resolution from each base down to its children, depth first: a base is inflated only
 *      if it has children, each child is read back from the pack by offset, patched (bounds-
 *      checked) and hashed; memory holds the chain being resolved, never the pack;
 *   3. `.idx` v2 written to `tmp_idx_*`; then, as git's finish_tmp_packfile, the pack is renamed
 *      into place first and the idx last — readers only see packs through their idx.
 * Any failure removes the temporaries: nothing is installed (quarantine).
 */
import { sha1 } from "@noble/hashes/legacy.js";
import type { FilesApi } from "@statewalker/webrun-files";
import {
  createInflaterPool,
  type StreamInflater,
} from "../../04-pooled-inflater/src/pooled-inflater.js";
import { CRC_INIT, crc32Update, crcFinal } from "./crc32.js";
import { applyDelta, DeltaError } from "./delta.js";

export class PackError extends Error {
  override name = "PackError";
}

export type ObjectTypeName = "commit" | "tree" | "blob" | "tag";

export interface IndexedEntry {
  oid: string;
  offset: number;
  crc32: number;
  type: ObjectTypeName;
  size: number;
}

export interface InstallResult {
  /** hex SHA-1 of the pack (its trailer); files are pack-<packId>.pack / .idx */
  packId: string;
  entries: IndexedEntry[];
  idx: Uint8Array;
}

const TYPES: Record<number, ObjectTypeName> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const OFS_DELTA = 6;
const REF_DELTA = 7;
const SLICE = 1024; // inflater input per push: one push yields at most ~1 MiB (X4)
const enc = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const hex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += HEX[x];
  return s;
};

interface Entry {
  offset: number;
  kind: number; // 1-4, 6, 7
  size: number; // inflated size (object or delta data)
  dataStart: number;
  end: number;
  crc: number;
  baseOffset?: number;
  baseOid?: string;
  oid?: string;
  type?: ObjectTypeName;
  objectSize?: number;
}

/** Sequential reader over a stored file: tracks position, the pack hash and the entry CRC. */
class PackReader {
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
  /** Account for `bytes` just consumed: entry CRC and (up to the trailer) the pack hash. */
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
  /** Inflate one zlib stream from the current position; `sink` receives the output. */
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
  /** Releases the underlying read (a Node FileHandle) also when parsing fails. */
  async close(): Promise<void> {
    await this.it.return?.();
  }
}

/** Phase 1: one pass over the stored pack. */
async function parse(files: FilesApi, path: string, packLen: number, maxObjectSize: number) {
  if (packLen < 32) throw new PackError("pack too short");
  const pool = createInflaterPool();
  const r = new PackReader(files.read(path), packLen - 20);
  try {
    return await parseWith(r, pool, packLen, maxObjectSize);
  } finally {
    await r.close();
  }
}

async function parseWith(
  r: PackReader,
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
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  for (let i = 0; i < count; i++) {
    r.crc = CRC_INIT;
    const offset = r.pos;
    if (offset >= packLen - 20) throw new PackError(`entry ${i} starts inside the trailer`);
    let b = await r.byte();
    const kind = (b >> 4) & 7;
    if (!TYPES[kind] && kind !== OFS_DELTA && kind !== REF_DELTA)
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
    const e: Entry = { offset, kind, size, dataStart: 0, end: 0, crc: 0 };
    if (kind === OFS_DELTA) {
      b = await r.byte();
      let back = b & 0x7f;
      while (b & 0x80) {
        b = await r.byte();
        back = (back + 1) * 128 + (b & 0x7f);
      }
      e.baseOffset = offset - back;
      if (back === 0 || e.baseOffset < 12 || !byOffset.has(e.baseOffset)) {
        throw new PackError(
          `OFS_DELTA at ${offset} points to ${e.baseOffset}, not an earlier entry`,
        );
      }
    } else if (kind === REF_DELTA) {
      e.baseOid = hex(await r.bytes(20));
    }
    e.dataStart = r.pos;
    const inflater = pool.acquire();
    let got = 0;
    const objHash = TYPES[kind]
      ? sha1.create().update(enc.encode(`${TYPES[kind]} ${size}\0`))
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
      try {
        inflater.end();
      } catch {
        // an unfinished stream reports truncation on end(); the error below says more
      }
      if (err instanceof PackError) throw err;
      throw new PackError(`entry at ${offset}: ${(err as Error).message}`);
    }
    if (got !== size)
      throw new PackError(`entry at ${offset} inflates to ${got} bytes, header says ${size}`);
    e.end = r.pos;
    e.crc = crcFinal(r.crc);
    if (objHash) {
      e.oid = hex(objHash.digest());
      e.type = TYPES[kind];
      e.objectSize = size;
    }
    entries.push(e);
    byOffset.set(offset, e);
  }
  if (r.pos !== packLen - 20)
    throw new PackError(`${packLen - 20 - r.pos} unexpected bytes before the trailer`);
  const expected = hex(r.hasher.digest());
  const trailer = hex(await r.bytes(20));
  if (trailer !== expected)
    throw new PackError(`pack checksum mismatch: trailer ${trailer}, content ${expected}`);
  if (!(await r.atEnd())) throw new PackError("bytes after the pack trailer");
  return { entries, byOffset, packId: trailer, pool };
}

/** Inflates one entry's data from the stored pack (bases and deltas in phase 2). */
async function load(
  files: FilesApi,
  path: string,
  e: Entry,
  inflater: StreamInflater,
): Promise<Uint8Array> {
  try {
    return await loadWith(files, path, e, inflater);
  } catch (err) {
    try {
      inflater.end();
    } catch {
      // see parse
    }
    throw err;
  }
}

async function loadWith(
  files: FilesApi,
  path: string,
  e: Entry,
  inflater: StreamInflater,
): Promise<Uint8Array> {
  const out = new Uint8Array(e.size); // e.size ≤ maxObjectSize, checked in phase 1
  let o = 0;
  let done = false;
  for await (const c of files.read(path, { start: e.dataStart, length: e.end - e.dataStart })) {
    for (let at = 0; at < c.length && !done; at += SLICE) {
      const r = inflater.push(c.subarray(at, at + SLICE));
      for (const x of r.out) {
        if (o + x.length > out.length) throw new PackError(`entry at ${e.offset} grew on re-read`);
        out.set(x, o);
        o += x.length;
      }
      done = r.done;
    }
  }
  if (!done || o !== e.size) throw new PackError(`entry at ${e.offset} could not be re-read`);
  return out;
}

/**
 * Phase 2: resolve every delta from its base downwards, depth first (explicit stack: chains can
 * be thousands deep). Memory, as git's index-pack (delta_base_cache_limit, prune_base_data /
 * get_base_data):
 *  - a frame whose children are all taken is released BEFORE its last child is descended into,
 *    so a linear chain holds the current base and the new result, not the whole chain;
 *  - frames below the top keep their content only within `baseCacheBytes`; an evicted base is
 *    re-derived on demand by following its own base links (entry → base entry … → a cached frame
 *    or a non-delta root), so releasing frames early never breaks re-derivation.
 */
async function resolveDeltas(
  files: FilesApi,
  path: string,
  parsed: Awaited<ReturnType<typeof parse>>,
  opts: { maxObjectSize: number; baseCacheBytes: number },
) {
  const ofsChildren = new Map<number, Entry[]>();
  const refChildren = new Map<string, Entry[]>();
  const byOid = new Map<string, Entry>();
  for (const e of parsed.entries) {
    if (e.baseOffset !== undefined) {
      const l = ofsChildren.get(e.baseOffset) ?? [];
      l.push(e);
      ofsChildren.set(e.baseOffset, l);
    } else if (e.baseOid !== undefined) {
      const l = refChildren.get(e.baseOid) ?? [];
      l.push(e);
      refChildren.set(e.baseOid, l);
    } else if (e.oid && !byOid.has(e.oid)) {
      byOid.set(e.oid, e);
    }
  }
  const childrenOf = (e: Entry) => [
    ...(ofsChildren.get(e.offset) ?? []),
    ...(refChildren.get(e.oid as string) ?? []),
  ];
  const loadEntry = (e: Entry) => load(files, path, e, parsed.pool.acquire());
  const patch = (base: Uint8Array, d: Uint8Array, at: number) => {
    try {
      return applyDelta(base, d, opts.maxObjectSize);
    } catch (err) {
      // only format errors become PackError; anything else (e.g. allocation failure) is not ours
      if (err instanceof DeltaError) throw new PackError(`delta at ${at}: ${err.message}`);
      throw err;
    }
  };

  type Frame = { entry: Entry; type: ObjectTypeName; content: Uint8Array | null; pending: Entry[] };
  const stack: Frame[] = [];
  const cached = new Map<number, Frame>(); // entry offset → its frame on the stack
  let held = 0;
  const evict = () => {
    for (let i = 0; i < stack.length - 1 && held > opts.baseCacheBytes; i++) {
      const f = stack[i] as Frame;
      if (f.content) {
        held -= f.content.length;
        f.content = null;
      }
    }
  };
  const push = (f: Frame) => {
    stack.push(f);
    cached.set(f.entry.offset, f);
    held += f.content?.length ?? 0;
    evict();
  };
  const pop = () => {
    const f = stack.pop() as Frame;
    cached.delete(f.entry.offset);
    held -= f.content?.length ?? 0;
  };
  /** Content of a resolved entry: from its frame if cached, else re-derived along its base links. */
  const derive = async (e: Entry): Promise<Uint8Array> => {
    const chain: Entry[] = [];
    let cur: Entry | undefined = e;
    let content: Uint8Array | undefined;
    while (cur) {
      const c = cached.get(cur.offset)?.content;
      if (c) {
        content = c;
        break;
      }
      if (cur.baseOffset === undefined && cur.baseOid === undefined) {
        content = await loadEntry(cur);
        break;
      }
      chain.push(cur);
      cur =
        cur.baseOffset !== undefined
          ? parsed.byOffset.get(cur.baseOffset)
          : byOid.get(cur.baseOid as string);
    }
    if (!content) throw new PackError(`cannot re-derive the base of the entry at ${e.offset}`);
    for (let k = chain.length - 1; k >= 0; k--) {
      const c = chain[k] as Entry;
      content = patch(content, await loadEntry(c), c.offset);
    }
    return content;
  };

  for (const root of parsed.entries) {
    if (!root.oid || root.baseOffset !== undefined || root.baseOid !== undefined) continue;
    const kids = childrenOf(root);
    if (kids.length === 0) continue;
    push({
      entry: root,
      type: root.type as ObjectTypeName,
      content: await loadEntry(root),
      pending: kids,
    });
    while (stack.length) {
      const top = stack[stack.length - 1] as Frame;
      const child = top.pending.pop();
      if (!child) {
        pop();
        continue;
      }
      if (child.oid) {
        // reachable from two bases with the same id (git: "already resolved (duplicate base)")
        throw new PackError(
          `delta at offset ${child.offset} already resolved (duplicate base ${top.entry.oid})`,
        );
      }
      let base = top.content;
      if (!base) {
        base = await derive(top.entry);
        top.content = base;
        held += base.length;
      }
      const result = patch(base, await loadEntry(child), child.offset);
      child.type = top.type;
      child.objectSize = result.length;
      child.oid = hex(
        sha1
          .create()
          .update(enc.encode(`${top.type} ${result.length}\0`))
          .update(result)
          .digest(),
      );
      if (!byOid.has(child.oid)) byOid.set(child.oid, child);
      const grand = childrenOf(child);
      if (top.pending.length === 0) pop(); // release the parent before descending (linear chains)
      if (grand.length) push({ entry: child, type: child.type, content: result, pending: grand });
    }
  }
  const missing = parsed.entries.filter((e) => !e.oid);
  if (missing.length) {
    const ref = missing.find((e) => e.baseOid !== undefined);
    throw new PackError(
      ref
        ? `${missing.length} deltas without a base in the pack (thin pack? first missing base ${ref.baseOid})`
        : `${missing.length} deltas could not be resolved`,
    );
  }
}

/** `.idx` version 2, laid out as git's write_idx_file. */
export function writeIdx(entries: IndexedEntry[], packId: string): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const n = sorted.length;
  const large = sorted.filter((e) => e.offset > 0x7fffffff);
  const size = 8 + 256 * 4 + n * 20 + n * 4 + n * 4 + large.length * 8 + 40;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set([0xff, 0x74, 0x4f, 0x63], 0);
  v.setUint32(4, 2);
  const fan = new Uint32Array(256);
  for (const e of sorted) (fan[Number.parseInt(e.oid.slice(0, 2), 16)] as number)++;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += fan[i] as number;
    v.setUint32(8 + i * 4, acc);
  }
  let p = 8 + 1024;
  const oidBytes = (h: string) =>
    Uint8Array.from(h.match(/../g) as string[], (x) => Number.parseInt(x, 16));
  for (const e of sorted) {
    out.set(oidBytes(e.oid), p);
    p += 20;
  }
  for (const e of sorted) {
    v.setUint32(p, e.crc32);
    p += 4;
  }
  let li = 0;
  for (const e of sorted) {
    v.setUint32(p, e.offset > 0x7fffffff ? (0x80000000 | li++) >>> 0 : e.offset);
    p += 4;
  }
  for (const e of large) {
    v.setUint32(p, Math.floor(e.offset / 2 ** 32));
    v.setUint32(p + 4, e.offset >>> 0);
    p += 8;
  }
  out.set(oidBytes(packId), p);
  p += 20;
  out.set(sha1(out.subarray(0, p)), p);
  return out;
}

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => HEX[b]).join("");

/**
 * Write `source` to `<packDir>/tmp_pack_*`, index it, write `tmp_idx_*`, then rename the pack and,
 * last, the idx into place. On any error every temporary is removed and nothing is installed.
 */
export interface InstallOptions {
  /** Largest object (or delta) accepted, by its header. Default 1 GiB. */
  maxObjectSize?: number;
  /** Bytes of resolved bases kept while resolving deltas; evicted bases are re-derived. Default 32 MiB. */
  baseCacheBytes?: number;
}

export async function installPack(
  files: FilesApi,
  packDir: string,
  source: AsyncIterable<Uint8Array>,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const maxObjectSize = opts.maxObjectSize ?? 2 ** 30;
  const baseCacheBytes = opts.baseCacheBytes ?? 32 * 2 ** 20;
  const dir = packDir.replace(/\/+$/, "");
  const tmpPack = `${dir}/tmp_pack_${rand()}`;
  const tmpIdx = `${dir}/tmp_idx_${rand()}`;
  try {
    await files.write(tmpPack, source);
    const stats = await files.stats(tmpPack);
    if (stats?.kind !== "file") throw new PackError("pack was not stored");
    const parsed = await parse(files, tmpPack, stats.size, maxObjectSize);
    await resolveDeltas(files, tmpPack, parsed, { maxObjectSize, baseCacheBytes });
    const entries: IndexedEntry[] = parsed.entries.map((e) => ({
      oid: e.oid as string,
      offset: e.offset,
      crc32: e.crc,
      type: e.type as ObjectTypeName,
      size: e.objectSize as number,
    }));
    const idx = writeIdx(entries, parsed.packId);
    const name = `${dir}/pack-${parsed.packId}`;
    if ((await files.exists(`${name}.pack`)) && (await files.exists(`${name}.idx`))) {
      // the same pack is already installed (a repeated fetch): keep it, as git does
      await files.remove(tmpPack);
      return { packId: parsed.packId, entries, idx };
    }
    await files.write(tmpIdx, [idx]);
    if (!(await files.move(tmpPack, `${name}.pack`))) throw new Error(`could not move ${tmpPack}`);
    if (!(await files.move(tmpIdx, `${name}.idx`))) throw new Error(`could not move ${tmpIdx}`);
    return { packId: parsed.packId, entries, idx };
  } catch (e) {
    await files.remove(tmpPack).catch(() => false);
    await files.remove(tmpIdx).catch(() => false);
    throw e;
  }
}
