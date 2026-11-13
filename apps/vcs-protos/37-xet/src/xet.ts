/**
 * X11 — Hugging Face Xet, as its specification (https://huggingface.co/docs/xet) and xet-core define
 * it: content-defined chunking, keyed BLAKE3 hashes aggregated into Merkle hashes, xorbs of
 * LZ4-compressed chunks, and file reconstruction from a CAS reconstruction answer.
 */

import { createBlake3 } from "../../03-sha256-blake3/src/hashes.js";
import { GEAR_TABLE } from "./gear-table.js";
import { lz4FrameDecode, lz4FrameEncode } from "./lz4.js";

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
  if (type === 0) {
    if (payload.length !== size) throw new Error("xorb: stored chunk of the wrong size");
    return payload.slice();
  }
  if (type === 1) return lz4FrameDecode(payload, size);
  if (type === 2) return bg4Regroup(lz4FrameDecode(payload, size));
  throw new Error(`xorb: unknown compression ${type}`);
}

/**
 * The first `count` chunks of a fetched xorb range, decoded one at a time as the bytes arrive; the
 * body is closed when done (a range may run on past them: later chunks, the `XETB` tail).
 */
async function* xorbChunks(
  bytes: AsyncIterable<Uint8Array>,
  count: number,
): AsyncGenerator<Uint8Array> {
  const it = bytes[Symbol.asyncIterator]();
  let buf = new Uint8Array(0);
  let pos = 0; // read position in buf: no copy of the rest per chunk
  const need = async (n: number) => {
    while (buf.length - pos < n) {
      const r = await it.next();
      if (r.done) return false;
      const joined = new Uint8Array(buf.length - pos + r.value.length);
      joined.set(buf.subarray(pos));
      joined.set(r.value, buf.length - pos);
      buf = joined;
      pos = 0;
    }
    return true;
  };
  try {
    for (let k = 0; k < count; k++) {
      if (!(await need(8))) throw new Error("xorb: range ends before its chunks");
      const version = buf[pos] as number;
      if (version !== 0) throw new Error(`xorb: chunk header version ${version}`);
      const csize =
        (buf[pos + 1] as number) |
        ((buf[pos + 2] as number) << 8) |
        ((buf[pos + 3] as number) << 16);
      const type = buf[pos + 4] as number;
      const usize =
        (buf[pos + 5] as number) |
        ((buf[pos + 6] as number) << 8) |
        ((buf[pos + 7] as number) << 16);
      if (!(await need(8 + csize))) throw new Error("xorb: truncated chunk");
      const chunk = decodeChunk(type, buf.subarray(pos + 8, pos + 8 + csize), usize);
      pos += 8 + csize;
      yield chunk;
    }
  } finally {
    await it.return?.();
  }
}

/** a chunk or a term whose bytes are not those its hash names */
export class XetIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XetIntegrityError";
  }
}

/** a term of the answer as the verifier sees it */
export interface VerifiedTerm {
  /** the xorb hash, lower case */
  xorb: string;
  start: number;
  end: number;
}

/**
 * What a reconstruction checks as it goes (X11b; open thread 4). The answer carries no hashes;
 * they come from a shard (`verifierFromShard`): the xorbs' chunk hashes (CAS section) and the
 * file's term verification hashes (File Info section).
 */
export interface ReconstructionVerifier {
  /**
   * Is `hash` (the decoded chunk's) the expected one for chunk `index` of `xorb` (lower case)?
   * `false` stops the reconstruction; `undefined`: not known, unchecked. Asked before the chunk
   * is yielded, so a damaged chunk stops the stream there, chunks before the term's first too.
   */
  chunk?: (xorb: string, index: number, hash: Uint8Array) => boolean | undefined;
  /**
   * The expected verification hash of a term (the plain hashes of its chunks, concatenated and
   * keyed with the verification key), or `undefined` (unchecked). Matched by the term's xorb and
   * chunk range, not by its position: a range request starts mid-file, and the server may split
   * a file's terms otherwise. Checked when the term's last chunk is decoded.
   */
  rangeHash?: (term: VerifiedTerm) => Uint8Array | undefined;
  /**
   * After the last term of a reconstruction that ran to the end (not cut short by `length`
   * inside a term): the terms it had. Throw (or return a message) to refuse it: a verifier that
   * knows the whole file can require all of it.
   */
  done?: (terms: VerifiedTerm[]) => string | undefined;
}

/**
 * Rebuilds a file from a reconstruction answer: for each term, the fetch entry of its xorb that
 * covers its chunk range is fetched and decoded chunk by chunk, and the term's chunks are yielded;
 * `offset_into_first_range` bytes of the first term are dropped, and `length` (a range request's
 * length) truncates the last. This is the v1 answer (`fetch_info`, `url_range` inclusive); v2's
 * `xorbs[].ranges[]` and multipart range fetches are not implemented. `verify` checks chunks and
 * terms against a shard's hashes as they stream (`ReconstructionVerifier`).
 */
export async function* reconstruct(
  answer: ReconstructionAnswer,
  fetchRange: FetchRange,
  opts: { length?: number; verify?: ReconstructionVerifier } = {},
): AsyncGenerator<Uint8Array> {
  const verify = opts.verify;
  const fail = (message: string): never => {
    throw verify ? new XetIntegrityError(message) : new Error(message);
  };
  let skip = answer.offset_into_first_range;
  let left = opts.length ?? Number.POSITIVE_INFINITY;
  const seen: VerifiedTerm[] = [];
  type Term = ReconstructionAnswer["terms"][number];
  type Entry = ReconstructionAnswer["fetch_info"][string][number];
  const entryOf = (term: Term): Entry => {
    const entry = (answer.fetch_info[term.hash] ?? []).find(
      (f) => f.range.start <= term.range.start && term.range.end <= f.range.end,
    );
    if (!entry)
      throw new Error(
        `reconstruction: no fetch range for ${term.hash} ${term.range.start}-${term.range.end}`,
      );
    return entry;
  };
  /** a term being decoded: what it produced, its chunk hashes, its expected range hash */
  const open = (term: Term) => {
    const vt: VerifiedTerm = {
      xorb: term.hash.toLowerCase(),
      start: term.range.start,
      end: term.range.end,
    };
    seen.push(vt);
    return { term, vt, expected: verify?.rangeHash?.(vt), hashes: [] as Uint8Array[], produced: 0 };
  };
  /** a term's own checks, once its last chunk is decoded */
  const check = (t: ReturnType<typeof open>) => {
    if (t.produced !== t.term.unpacked_length)
      fail(
        `reconstruction: term ${t.term.hash} gave ${t.produced} bytes, expected ${t.term.unpacked_length}`,
      );
    if (t.expected) {
      const got = rangeHash(t.hashes);
      const want = t.expected;
      if (!got.every((b, k) => b === want[k]))
        fail(
          `reconstruction: term ${t.term.hash} ${t.term.range.start}-${t.term.range.end} does not match its verification hash`,
        );
    }
  };

  const terms = answer.terms;
  const empty = (t: Term) => t.range.end <= t.range.start;
  for (let first = 0; first < terms.length; ) {
    if (empty(terms[first] as Term)) {
      // no chunk to fetch: checked at once (its bytes, and its verification hash over none)
      check(open(terms[first] as Term));
      first++;
      continue;
    }
    // One fetch for the consecutive terms of one fetch entry whose chunk ranges go forward
    // (open thread 2): the entry's bytes are fetched once, not once per term. Forming the group
    // looks up the next terms' fetch entries, so an answer missing one is refused before the
    // group's bytes are yielded.
    const entry = entryOf(terms[first] as Term);
    let last = first;
    while (
      last + 1 < terms.length &&
      !empty(terms[last + 1] as Term) &&
      (terms[last + 1] as Term).hash === (terms[first] as Term).hash &&
      entryOf(terms[last + 1] as Term) === entry &&
      (terms[last + 1] as Term).range.start >= (terms[last] as Term).range.end
    )
      last++;
    let k = first;
    let current = open(terms[k] as Term);
    let index = entry.range.start;
    const bytes = fetchRange(entry.url, entry.url_range.start, entry.url_range.end);
    const upTo = (terms[last] as Term).range.end - entry.range.start;
    for await (const chunk of xorbChunks(bytes, upTo)) {
      const i = index++;
      const inTerm = i >= current.term.range.start;
      if (verify?.chunk || (current.expected && inTerm)) {
        const h = chunkHash(chunk);
        if (verify?.chunk?.(current.vt.xorb, i, h) === false)
          fail(`reconstruction: chunk ${i} of xorb ${current.term.hash} is damaged`);
        if (inTerm) current.hashes.push(h);
      }
      if (!inTerm) continue; // before the term (its fetch range starts earlier, or a gap)
      current.produced += chunk.length;
      const endsTerm = i === current.term.range.end - 1;
      if (skip >= chunk.length) skip -= chunk.length;
      else {
        const piece = skip ? chunk.subarray(skip) : chunk;
        skip = 0;
        if (piece.length >= left) {
          yield piece.subarray(0, left);
          // ending exactly at the term's end: the term is whole, so it is checked (and, as the
          // reconstruction is whole up to `length`, `done` too)
          if (piece.length === left && endsTerm) {
            check(current);
            if (k === terms.length - 1) {
              const refused = verify?.done?.(seen);
              if (refused) fail(`reconstruction: ${refused}`);
            }
          }
          return;
        }
        left -= piece.length;
        yield piece;
      }
      if (endsTerm) {
        check(current);
        if (k === last) break;
        current = open(terms[++k] as Term);
      }
    }
    if (k !== last || current.produced < current.term.unpacked_length) check(current);
    first = last + 1;
  }
  const refused = verify?.done?.(seen);
  if (refused) fail(`reconstruction: ${refused}`);
}

/** at most this many chunks in a xorb (the specification's MUST) */
export const XORB_MAX_CHUNKS = 8192;
/** at most this much chunk data in a xorb (the specification's SHOULD, kept as a limit here) */
export const XORB_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A serialized xorb of `chunks`: an 8-byte header (version 0, compressed size, compression type,
 * uncompressed size) and the payload per chunk, ending right after the last chunk (no footer: the
 * specification forbids trailing bytes). LZ4 by default; a chunk LZ4 would not shrink is stored
 * uncompressed, as the specification advises.
 */
export function writeXorb(
  chunks: Uint8Array[],
  o: { compression?: "none" | "lz4" | "bg4-lz4" } = {},
): Uint8Array {
  if (chunks.length > XORB_MAX_CHUNKS)
    throw new Error(`xorb: ${chunks.length} chunks (at most ${XORB_MAX_CHUNKS})`);
  const data = chunks.reduce((n, c) => n + c.length, 0);
  if (data > XORB_MAX_BYTES) throw new Error(`xorb: ${data} bytes of chunks (at most 64 MiB)`);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const c of chunks) {
    if (c.length === 0) throw new Error("xorb: an empty chunk");
    if (c.length >= 1 << 24) throw new Error("xorb: a chunk of 16 MiB or more");
    let type = 0;
    let payload = c;
    if (o.compression !== "none") {
      const packed = lz4FrameEncode(o.compression === "bg4-lz4" ? bg4Split(c) : c);
      if (packed.length < c.length) {
        type = o.compression === "bg4-lz4" ? 2 : 1;
        payload = packed;
      }
    }
    const header = new Uint8Array(8);
    header[0] = 0;
    header[1] = payload.length & 0xff;
    header[2] = (payload.length >> 8) & 0xff;
    header[3] = (payload.length >> 16) & 0xff;
    header[4] = type;
    header[5] = c.length & 0xff;
    header[6] = (c.length >> 8) & 0xff;
    header[7] = (c.length >> 16) & 0xff;
    parts.push(header, payload);
    total += 8 + payload.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** ByteGrouping4: byte k of every 4-byte group into group k (the inverse of `bg4Regroup`) */
export function bg4Split(data: Uint8Array): Uint8Array {
  const n = data.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (let g = 0; g < 4; g++) for (let i = g; i < n; i += 4) out[at++] = data[i] as number;
  return out;
}
