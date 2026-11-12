/**
 * X11 — Hugging Face Xet, as its specification (https://huggingface.co/docs/xet) and xet-core define
 * it: content-defined chunking, keyed BLAKE3 hashes aggregated into Merkle hashes, xorbs of
 * LZ4-compressed chunks, and file reconstruction from a CAS reconstruction answer.
 */

import { createBlake3 } from "../../03-sha256-blake3/src/hashes.js";
import { GEAR_TABLE } from "./gear-table.js";
import { lz4FrameDecode } from "./lz4.js";

export interface ChunkRef {
  hash: Uint8Array;
  length: number;
}

// ---------------------------------------------------------------- hashes

const DATA_KEY = Uint8Array.from([
  102, 151, 245, 119, 91, 149, 80, 222, 49, 53, 203, 172, 165, 151, 24, 28, 157, 228, 33, 16, 155,
  235, 43, 88, 180, 208, 176, 75, 147, 173, 242, 41,
]);
const INTERNAL_NODE_KEY = Uint8Array.from([
  1, 126, 197, 199, 165, 71, 41, 150, 253, 148, 102, 102, 180, 138, 2, 230, 93, 221, 83, 111, 55,
  199, 109, 210, 248, 99, 82, 230, 74, 83, 113, 63,
]);
const VERIFICATION_KEY = Uint8Array.from([
  127, 24, 87, 214, 206, 86, 237, 102, 18, 127, 249, 19, 231, 165, 195, 243, 164, 205, 38, 213, 181,
  219, 73, 230, 65, 36, 152, 127, 40, 251, 148, 195,
]);
const ZERO_KEY = new Uint8Array(32);
const keyed = (key: Uint8Array, data: Uint8Array) => createBlake3({ key }).update(data).digest();
const enc = new TextEncoder();

/**
 * A hash as Xet prints it: four 64-bit little-endian words, each in hex (so each group of eight
 * bytes reads backwards).
 */
export function hashToString(h: Uint8Array): string {
  let s = "";
  for (let w = 0; w < 4; w++)
    for (let i = 7; i >= 0; i--) s += (h[w * 8 + i] as number).toString(16).padStart(2, "0");
  return s;
}
export function hashFromString(s: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`not a Xet hash: ${s}`);
  const h = new Uint8Array(32);
  for (let w = 0; w < 4; w++)
    for (let i = 0; i < 8; i++)
      h[w * 8 + 7 - i] = Number.parseInt(s.slice(w * 16 + i * 2, w * 16 + i * 2 + 2), 16);
  return h;
}

/** a chunk's hash: BLAKE3 keyed with DATA_KEY */
export const chunkHash = (data: Uint8Array): Uint8Array => keyed(DATA_KEY, data);

/** an internal node: `{hash} : {size}\n` per child, keyed with INTERNAL_NODE_KEY */
function mergedHash(children: ChunkRef[]): ChunkRef {
  let text = "";
  let length = 0;
  for (const c of children) {
    text += `${hashToString(c.hash)} : ${c.length}\n`;
    length += c.length;
  }
  return { hash: keyed(INTERNAL_NODE_KEY, enc.encode(text)), length };
}

/**
 * How many of `nodes` the next group takes (xet-core's `next_merge_cut`): at least 2, at most 9;
 * a node whose hash is 0 mod 4 (its last word, little-endian) ends a group from the third on.
 */
function nextCut(nodes: ChunkRef[], from: number): number {
  const left = nodes.length - from;
  if (left <= 2) return left;
  const end = Math.min(9, left);
  for (let i = 2; i < end; i++) if (((nodes[from + i]?.hash[24] as number) & 3) === 0) return i + 1;
  return end;
}

/** the root of xet-core's aggregated Merkle tree (mean branching 4) */
function aggregated(chunks: ChunkRef[]): Uint8Array {
  if (!chunks.length) return new Uint8Array(32);
  let level = chunks;
  while (level.length > 1) {
    const next: ChunkRef[] = [];
    for (let at = 0; at < level.length; ) {
      const n = nextCut(level, at);
      next.push(mergedHash(level.slice(at, at + n)));
      at += n;
    }
    level = next;
  }
  return (level[0] as ChunkRef).hash;
}

/** a xorb's hash: the Merkle root over its chunks */
export const xorbHash = (chunks: ChunkRef[]): Uint8Array => aggregated(chunks);
/** a file's hash: the Merkle root over its chunks, keyed once more with a zero key */
export const fileHash = (chunks: ChunkRef[]): Uint8Array =>
  chunks.length ? keyed(ZERO_KEY, aggregated(chunks)) : new Uint8Array(32);
/** a verification range hash: the chunk hashes concatenated, keyed with VERIFICATION_KEY */
export function rangeHash(hashes: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(hashes.length * 32);
  hashes.forEach((h, i) => {
    all.set(h, i * 32);
  });
  return keyed(VERIFICATION_KEY, all);
}

// ---------------------------------------------------------------- chunking

const MIN_CHUNK = 8 * 1024;
const MAX_CHUNK = 128 * 1024;
/** the first byte hashed: the gear hash looks back 64 bytes, so the minimum size less 64, less 1 */
const FIRST_HASHED = MIN_CHUNK - 64 - 1;
const GEAR_HI = Uint32Array.from(GEAR_TABLE, (v) => Number(v >> 32n));
const GEAR_LO = Uint32Array.from(GEAR_TABLE, (v) => Number(v & 0xffffffffn));

/**
 * Xet's content-defined chunks of a byte stream: the gear hash `h = (h << 1) + TABLE[b]` (64-bit,
 * kept as two 32-bit halves), a boundary after a byte where `h & 0xFFFF000000000000 == 0` once the
 * chunk has at least 8 KiB, and always at 128 KiB; the hash restarts at each boundary.
 */
export async function* chunkStream(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let parts: Uint8Array[] = [];
  let length = 0; // bytes in the current chunk
  let hi = 0;
  let lo = 0;
  const take = (): Uint8Array => {
    const out = new Uint8Array(length);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    parts = [];
    length = 0;
    hi = 0;
    lo = 0;
    return out;
  };
  for await (const piece of source) {
    let start = 0;
    let i = 0;
    while (i < piece.length) {
      // skip what cannot end a chunk nor affect its first possible boundary
      if (length < FIRST_HASHED) {
        const skip = Math.min(FIRST_HASHED - length, piece.length - i);
        i += skip;
        length += skip;
        continue;
      }
      const b = piece[i] as number;
      const nlo = (lo << 1) >>> 0;
      const nhi = ((hi << 1) | (lo >>> 31)) >>> 0;
      const sum = nlo + (GEAR_LO[b] as number);
      lo = sum >>> 0;
      hi = (nhi + (GEAR_HI[b] as number) + (sum > 0xffffffff ? 1 : 0)) >>> 0;
      i++;
      length++;
      if ((length >= MIN_CHUNK && hi >>> 16 === 0) || length === MAX_CHUNK) {
        parts.push(piece.subarray(start, i));
        start = i;
        yield take();
      }
    }
    if (start < piece.length) parts.push(piece.slice(start));
  }
  if (length) yield take();
}

// ---------------------------------------------------------------- xorbs and reconstruction

export interface ReconstructionAnswer {
  /** bytes to drop from the first term's output (a range request) */
  offset_into_first_range: number;
  terms: { hash: string; unpacked_length: number; range: { start: number; end: number } }[];
  fetch_info: Record<
    string,
    {
      range: { start: number; end: number };
      url: string;
      /** inclusive byte range of the xorb holding chunks `range` */
      url_range: { start: number; end: number };
    }[]
  >;
}
/** fetches bytes `start`…`end` (inclusive) of `url`, as they arrive */
export type FetchRange = (url: string, start: number, end: number) => AsyncIterable<Uint8Array>;

/** groups 0…3 of ByteGrouping4 back into one buffer (xet-core's bg4_split_together, reversed) */
export function bg4Regroup(grouped: Uint8Array): Uint8Array {
  const n = grouped.length;
  const split = Math.floor(n / 4);
  const rem = n % 4;
  const sizes = [0, 1, 2, 3].map((g) => split + (g < rem ? 1 : 0));
  const out = new Uint8Array(n);
  let base = 0;
  for (let g = 0; g < 4; g++) {
    for (let i = 0; i < (sizes[g] as number); i++) out[4 * i + g] = grouped[base + i] as number;
    base += sizes[g] as number;
  }
  return out;
}

/** one chunk of a xorb: its 8-byte header (version 0, sizes as 3 bytes little-endian) and payload */
function decodeChunk(type: number, payload: Uint8Array, size: number): Uint8Array {
  if (type === 0) return payload.slice();
  if (type === 1) return lz4FrameDecode(payload, size);
  if (type === 2) return bg4Regroup(lz4FrameDecode(payload, size));
  throw new Error(`xorb: unknown compression ${type}`);
}

/** the chunks of a fetched xorb range, decoded one at a time as the bytes arrive */
async function* xorbChunks(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let buf = new Uint8Array(0);
  const need = async (it: AsyncIterator<Uint8Array>, n: number) => {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) return false;
      const joined = new Uint8Array(buf.length + r.value.length);
      joined.set(buf);
      joined.set(r.value, buf.length);
      buf = joined;
    }
    return true;
  };
  const it = bytes[Symbol.asyncIterator]();
  for (;;) {
    if (!(await need(it, 8))) {
      if (buf.length) throw new Error("xorb: truncated chunk header");
      return;
    }
    const version = buf[0] as number;
    if (version !== 0) throw new Error(`xorb: chunk header version ${version}`);
    const csize = (buf[1] as number) | ((buf[2] as number) << 8) | ((buf[3] as number) << 16);
    const type = buf[4] as number;
    const usize = (buf[5] as number) | ((buf[6] as number) << 8) | ((buf[7] as number) << 16);
    if (!(await need(it, 8 + csize))) throw new Error("xorb: truncated chunk");
    yield decodeChunk(type, buf.subarray(8, 8 + csize), usize);
    buf = buf.slice(8 + csize);
  }
}

/**
 * Rebuilds a file from a reconstruction answer: for each term, the fetch entry of its xorb that
 * covers its chunk range is fetched and decoded chunk by chunk, and the term's chunks are yielded;
 * `offset_into_first_range` bytes of the first term are dropped.
 */
export async function* reconstruct(
  answer: ReconstructionAnswer,
  fetchRange: FetchRange,
  _opts: { length?: number } = {},
): AsyncGenerator<Uint8Array> {
  let skip = answer.offset_into_first_range;
  for (const term of answer.terms) {
    const entry = (answer.fetch_info[term.hash] ?? []).find(
      (f) => f.range.start <= term.range.start && term.range.end <= f.range.end,
    );
    if (!entry)
      throw new Error(
        `reconstruction: no fetch range for ${term.hash} ${term.range.start}-${term.range.end}`,
      );
    let index = entry.range.start;
    let produced = 0;
    for await (const chunk of xorbChunks(
      fetchRange(entry.url, entry.url_range.start, entry.url_range.end),
    )) {
      const i = index++;
      if (i < term.range.start) continue;
      if (i >= term.range.end) break;
      produced += chunk.length;
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      yield skip ? chunk.subarray(skip) : chunk;
      skip = 0;
    }
    if (produced !== term.unpacked_length)
      throw new Error(
        `reconstruction: term ${term.hash} gave ${produced} bytes, expected ${term.unpacked_length}`,
      );
  }
}
