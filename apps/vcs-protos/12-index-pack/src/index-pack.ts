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
import { applyDelta } from "./delta.js";

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
}

/** Phase 1: one pass over the stored pack. */
async function parse(files: FilesApi, path: string, packLen: number) {
  if (packLen < 32) throw new PackError("pack too short");
  const pool = createInflaterPool();
  const r = new PackReader(files.read(path), packLen - 20);
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
        objHash?.update(out);
      });
    } catch (err) {
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
  const out = new Uint8Array(e.size);
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

/** Phase 2: resolve every delta from its base downwards (explicit stack: chains can be deep). */
async function resolveDeltas(
  files: FilesApi,
  path: string,
  parsed: Awaited<ReturnType<typeof parse>>,
) {
  const ofsChildren = new Map<number, Entry[]>();
  const refChildren = new Map<string, Entry[]>();
  for (const e of parsed.entries) {
    if (e.baseOffset !== undefined) {
      const l = ofsChildren.get(e.baseOffset) ?? [];
      l.push(e);
      ofsChildren.set(e.baseOffset, l);
    } else if (e.baseOid !== undefined) {
      const l = refChildren.get(e.baseOid) ?? [];
      l.push(e);
      refChildren.set(e.baseOid, l);
    }
  }
  const childrenOf = (e: Entry) => [
    ...(ofsChildren.get(e.offset) ?? []),
    ...(refChildren.get(e.oid as string) ?? []),
  ];
  for (const root of parsed.entries) {
    if (!root.oid || root.baseOffset !== undefined || root.baseOid !== undefined) continue;
    if (childrenOf(root).length === 0) continue;
    // stack of (base content, pending children)
    const stack: { content: Uint8Array; type: ObjectTypeName; pending: Entry[] }[] = [
      {
        content: await load(files, path, root, parsed.pool.acquire()),
        type: root.type as ObjectTypeName,
        pending: childrenOf(root),
      },
    ];
    while (stack.length) {
      const top = stack[stack.length - 1] as (typeof stack)[number];
      const child = top.pending.pop();
      if (!child) {
        stack.pop();
        continue;
      }
      if (child.oid) continue; // already resolved through another base (duplicate object)
      const delta = await load(files, path, child, parsed.pool.acquire());
      let result: Uint8Array;
      try {
        result = applyDelta(top.content, delta);
      } catch (err) {
        throw new PackError(`delta at ${child.offset}: ${(err as Error).message}`);
      }
      child.type = top.type;
      child.objectSize = result.length;
      child.oid = hex(
        sha1
          .create()
          .update(enc.encode(`${top.type} ${result.length}\0`))
          .update(result)
          .digest(),
      );
      const grand = childrenOf(child);
      if (grand.length) stack.push({ content: result, type: top.type, pending: grand });
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
export async function installPack(
  files: FilesApi,
  packDir: string,
  source: AsyncIterable<Uint8Array>,
): Promise<InstallResult> {
  const dir = packDir.replace(/\/+$/, "");
  const tmpPack = `${dir}/tmp_pack_${rand()}`;
  const tmpIdx = `${dir}/tmp_idx_${rand()}`;
  try {
    await files.write(tmpPack, source);
    const stats = await files.stats(tmpPack);
    if (stats?.kind !== "file") throw new PackError("pack was not stored");
    const parsed = await parse(files, tmpPack, stats.size);
    await resolveDeltas(files, tmpPack, parsed);
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
