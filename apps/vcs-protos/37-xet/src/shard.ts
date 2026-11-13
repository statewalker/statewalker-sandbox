/**
 * X11b — Xet shards (https://huggingface.co/docs/xet/shard): the File Info section (a file's terms
 * over xorb chunk ranges, their verification hashes, its SHA-256) and the CAS Info section (a
 * xorb's chunks), written and read byte for byte as the specification's reference shards hold
 * them, and the deduplication lookup a global-dedupe shard answers (keyed chunk hashes).
 *
 * All integers little-endian; hashes as their 32 raw bytes (`hashToString` prints them).
 */

import { createBlake3 } from "../../03-sha256-blake3/src/hashes.js";
import {
  type ChunkRef,
  hashFromString,
  hashToString,
  type ReconstructionVerifier,
  rangeHash,
} from "./xet.js";

/** `MDB_SHARD_HEADER_TAG`, as the reference shards begin */
export const SHARD_HEADER_TAG = Uint8Array.from([
  0x48, 0x46, 0x52, 0x65, 0x70, 0x6f, 0x4d, 0x65, 0x74, 0x61, 0x44, 0x61, 0x74, 0x61, 0x00, 0x55,
  0x69, 0x67, 0x45, 0x6a, 0x7b, 0x81, 0x57, 0x83, 0xa5, 0xbd, 0xd9, 0x5c, 0xcd, 0xd1, 0x4a, 0xa9,
]);
const HEADER_VERSION = 2;
const FOOTER_VERSION = 1;
const ENTRY = 48;
const FOOTER_SIZE = 200;
export const FILE_FLAG_WITH_VERIFICATION = 0x80000000;
export const FILE_FLAG_WITH_METADATA_EXT = 0x40000000;

/** a file's term: chunks `[start, end)` of one xorb */
export interface FileTerm {
  xorbHash: Uint8Array;
  /** the term's uncompressed bytes */
  bytes: number;
  start: number;
  end: number;
  /** its verification hash (written when every term of every file has one) */
  rangeHash?: Uint8Array;
}
export interface FileInfo {
  fileHash: Uint8Array;
  terms: FileTerm[];
  /**
   * the file's SHA-256 as the metadata extension stores it (required for Git-based repositories):
   * in Xet's hash layout, see `metadataSha256`
   */
  sha256?: Uint8Array;
}
export interface XorbInfo {
  xorbHash: Uint8Array;
  chunks: ChunkRef[];
  /** the serialized xorb's length (`num_bytes_on_disk`); the reference shards leave it 0 */
  bytesOnDisk?: number;
  /** per chunk, `chunk_flags` (bit 31: indexed for global dedupe); 0 when uploading */
  chunkFlags?: number[];
}
export interface ShardFooter {
  /** keys the CAS section's chunk hashes (a global-dedupe answer); zero: none */
  chunkHashKey?: Uint8Array;
  /** seconds since the epoch */
  creationTimestamp?: number;
  keyExpiry?: number;
}
export interface Shard {
  files: FileInfo[];
  xorbs: XorbInfo[];
  /** absent: the upload form, with no footer (`footer_size` 0) */
  footer?: ShardFooter;
  /**
   * the CAS section's chunk hashes are keyed already (as read from a keyed shard); otherwise a
   * footer key keys them when written
   */
  chunkHashesKeyed?: boolean;
}

/**
 * The keyed chunk hash a global-dedupe shard stores: BLAKE3 keyed with the footer's key over the
 * chunk hash's 32 bytes (the specification's `HMAC`, which is not RFC 2104's).
 */
export const keyedChunkHash = (hash: Uint8Array, key: Uint8Array): Uint8Array =>
  createBlake3({ key }).update(hash).digest();

const isZero = (b: Uint8Array) => b.every((x) => x === 0);

/**
 * A SHA-256 digest as the metadata extension stores it: the digest's hex read as a Xet hash string,
 * so each eight-byte word is reversed (the reference shards hold it so; the specification only
 * says "the 32 byte SHA256").
 */
export const metadataSha256 = (digest: Uint8Array): Uint8Array =>
  hashFromString(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));

/**
 * Serializes a shard as the reference shards are: no lookup tables, the byte counts the footer
 * sums. Verification entries go to every term of every file or to none (an upload needs them
 * everywhere; a shard mixing files with and without is valid to read but not written here).
 */
export function writeShard(shard: Shard): Uint8Array {
  const footerKey = shard.footer?.chunkHashKey;
  if (shard.chunkHashesKeyed && (!footerKey || isZero(footerKey)))
    throw new Error(
      "shard: keyed chunk hashes without the footer key (an upload would carry them)",
    );
  const withVerification = shard.files.some((f) => f.terms.some((t) => t.rangeHash));
  if (withVerification && !shard.files.every((f) => f.terms.every((t) => t.rangeHash)))
    throw new Error("shard: verification hashes for some terms only (the shard would be invalid)");
  let size = ENTRY; // header
  for (const f of shard.files)
    size += ENTRY * (1 + f.terms.length * (withVerification ? 2 : 1) + (f.sha256 ? 1 : 0));
  size += ENTRY; // file bookend
  for (const x of shard.xorbs) size += ENTRY * (1 + x.chunks.length);
  size += ENTRY; // CAS bookend
  const casInfoOffset =
    ENTRY +
    shard.files.reduce(
      (n, f) => n + ENTRY * (1 + f.terms.length * (withVerification ? 2 : 1) + (f.sha256 ? 1 : 0)),
      0,
    ) +
    ENTRY;
  const footerOffset = size;
  if (shard.footer) size += FOOTER_SIZE;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let at = 0;
  const hash = (h: Uint8Array) => {
    if (h.length !== 32) throw new Error("shard: a hash is 32 bytes");
    out.set(h, at);
    at += 32;
  };
  const u32 = (n: number) => {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`shard: ${n} is no u32`);
    v.setUint32(at, n, true);
    at += 4;
  };
  const u64 = (n: number) => {
    v.setBigUint64(at, BigInt(n), true);
    at += 8;
  };
  const bookend = () => {
    out.fill(0xff, at, at + 32);
    at += ENTRY; // and 16 zero bytes
  };

  out.set(SHARD_HEADER_TAG, 0);
  at = 32;
  u64(HEADER_VERSION);
  u64(shard.footer ? FOOTER_SIZE : 0);

  let materialized = 0;
  for (const f of shard.files) {
    hash(f.fileHash);
    // a sum, not `|`: `|` of the two flags is a negative int32
    u32(
      (withVerification ? FILE_FLAG_WITH_VERIFICATION : 0) +
        (f.sha256 ? FILE_FLAG_WITH_METADATA_EXT : 0),
    );
    u32(f.terms.length);
    at += 8;
    for (const t of f.terms) {
      hash(t.xorbHash);
      u32(0);
      u32(t.bytes);
      u32(t.start);
      u32(t.end);
      materialized += t.bytes;
    }
    if (withVerification)
      for (const t of f.terms) {
        hash(t.rangeHash as Uint8Array);
        at += 16;
      }
    if (f.sha256) {
      hash(f.sha256);
      at += 16;
    }
  }
  bookend();

  let stored = 0;
  let storedOnDisk = 0;
  const key = shard.footer?.chunkHashKey;
  for (const x of shard.xorbs) {
    const bytes = x.chunks.reduce((n, c) => n + c.length, 0);
    hash(x.xorbHash);
    u32(0);
    u32(x.chunks.length);
    u32(bytes);
    u32(x.bytesOnDisk ?? 0);
    stored += bytes;
    storedOnDisk += x.bytesOnDisk ?? 0;
    let offset = 0;
    x.chunks.forEach((c, i) => {
      hash(key && !isZero(key) && !shard.chunkHashesKeyed ? keyedChunkHash(c.hash, key) : c.hash);
      u32(offset); // uncompressed offsets: the server refuses compressed ones
      u32(c.length);
      u32(x.chunkFlags?.[i] ?? 0);
      at += 4;
      offset += c.length;
    });
  }
  bookend();

  if (shard.footer) {
    const f = shard.footer;
    u64(FOOTER_VERSION);
    u64(ENTRY); // file info offset
    u64(casInfoOffset);
    // no lookup tables: each offset at the footer, no entries (as API-returned shards)
    for (let i = 0; i < 3; i++) {
      u64(footerOffset);
      u64(0);
    }
    hash(f.chunkHashKey ?? new Uint8Array(32));
    u64(f.creationTimestamp ?? 0);
    u64(f.keyExpiry ?? 0);
    at += 48;
    u64(storedOnDisk);
    u64(materialized);
    u64(stored);
    u64(footerOffset);
  }
  if (at !== size) throw new Error(`shard: wrote ${at} of ${size} bytes`);
  return out;
}

/**
 * Reads a shard (with or without its footer); keyed chunk hashes are returned as stored. Lookup
 * tables (between the CAS section and the footer) and the footer's offsets and byte counts are
 * not kept: written again, such a shard has no tables.
 */
export function readShard(bytes: Uint8Array): Shard {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (at: number, n: number) => {
    if (at + n > bytes.length) throw new Error("shard: truncated");
  };
  need(0, ENTRY);
  for (let i = 0; i < 32; i++)
    if (bytes[i] !== SHARD_HEADER_TAG[i]) throw new Error("shard: not a shard (header tag)");
  if (v.getBigUint64(32, true) !== BigInt(HEADER_VERSION))
    throw new Error("shard: header version is not 2");
  const footerSize = Number(v.getBigUint64(40, true));
  if (footerSize !== 0 && footerSize !== FOOTER_SIZE)
    throw new Error(`shard: footer size ${footerSize}`);
  const hash = (at: number) => bytes.slice(at, at + 32);
  const isBookend = (at: number) => {
    for (let i = 0; i < 32; i++) if (bytes[at + i] !== 0xff) return false;
    return true;
  };
  let at = ENTRY;
  const files: FileInfo[] = [];
  for (;;) {
    need(at, ENTRY);
    if (isBookend(at)) {
      at += ENTRY;
      break;
    }
    const flags = v.getUint32(at + 32, true);
    const n = v.getUint32(at + 36, true);
    const file: FileInfo = { fileHash: hash(at), terms: [] };
    at += ENTRY;
    need(at, n * ENTRY);
    for (let i = 0; i < n; i++, at += ENTRY)
      file.terms.push({
        xorbHash: hash(at),
        bytes: v.getUint32(at + 36, true),
        start: v.getUint32(at + 40, true),
        end: v.getUint32(at + 44, true),
      });
    if (flags & FILE_FLAG_WITH_VERIFICATION) {
      need(at, n * ENTRY);
      for (const t of file.terms) {
        t.rangeHash = hash(at);
        at += ENTRY;
      }
    }
    if (flags & FILE_FLAG_WITH_METADATA_EXT) {
      need(at, ENTRY);
      file.sha256 = hash(at);
      at += ENTRY;
    }
    files.push(file);
  }
  const xorbs: XorbInfo[] = [];
  for (;;) {
    need(at, ENTRY);
    if (isBookend(at)) {
      at += ENTRY;
      break;
    }
    const n = v.getUint32(at + 36, true);
    const x: XorbInfo = {
      xorbHash: hash(at),
      chunks: [],
      bytesOnDisk: v.getUint32(at + 44, true),
      chunkFlags: [],
    };
    at += ENTRY;
    need(at, n * ENTRY);
    for (let i = 0; i < n; i++, at += ENTRY) {
      x.chunks.push({ hash: hash(at), length: v.getUint32(at + 36, true) });
      x.chunkFlags?.push(v.getUint32(at + 40, true));
    }
    xorbs.push(x);
  }
  if (!footerSize) {
    if (at !== bytes.length) throw new Error("shard: bytes after the CAS section, and no footer");
    return { files, xorbs };
  }
  const f = bytes.length - FOOTER_SIZE;
  if (f < at) throw new Error("shard: truncated footer");
  if (v.getBigUint64(f, true) !== BigInt(FOOTER_VERSION))
    throw new Error("shard: footer version is not 1");
  if (Number(v.getBigUint64(f + 192, true)) !== f) throw new Error("shard: footer offset");
  const chunkHashKey = hash(f + 72);
  return {
    files,
    xorbs,
    ...(isZero(chunkHashKey) ? {} : { chunkHashesKeyed: true }),
    footer: {
      chunkHashKey,
      creationTimestamp: Number(v.getBigUint64(f + 104, true)),
      keyExpiry: Number(v.getBigUint64(f + 112, true)),
    },
  };
}

/** where a chunk is: the xorb and the chunk's index in it */
export interface ChunkLocation {
  xorbHash: Uint8Array;
  index: number;
}

/**
 * The deduplication index of shards (an upload's own, or global-dedupe answers): a chunk hash to
 * the xorb and index holding it. A shard whose footer has a key stores keyed chunk hashes; the
 * lookup keys the asked hash with it.
 */
export function dedupeIndex(shards: Shard[]): (hash: Uint8Array) => ChunkLocation | undefined {
  const plain = new Map<string, ChunkLocation>();
  const byKey: { key: Uint8Array; map: Map<string, ChunkLocation> }[] = [];
  const hex = (h: Uint8Array) => Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
  for (const s of shards) {
    const key = s.footer?.chunkHashKey;
    let map = plain;
    // keyed as stored (read from a keyed shard); an in-memory shard to be written holds plain ones
    if (key && !isZero(key) && s.chunkHashesKeyed) {
      map = new Map();
      byKey.push({ key, map });
    }
    for (const x of s.xorbs)
      x.chunks.forEach((c, index) => {
        const k = hex(c.hash);
        if (!map.has(k)) map.set(k, { xorbHash: x.xorbHash, index });
      });
  }
  return (hash) =>
    plain.get(hex(hash)) ??
    byKey.map(({ key, map }) => map.get(hex(keyedChunkHash(hash, key)))).find(Boolean);
}

/**
 * A file's terms from its chunks and where each is: consecutive chunks at consecutive indexes of
 * one xorb make one term, with its verification hash over that xorb's chunk hashes (which are the
 * file's own chunk hashes, in order).
 */
export function termsFor(
  chunks: ChunkRef[],
  locate: (hash: Uint8Array, i: number) => ChunkLocation,
): FileTerm[] {
  const terms: FileTerm[] = [];
  let open: { term: FileTerm; hashes: Uint8Array[] } | undefined;
  const close = () => {
    if (open) {
      open.term.rangeHash = rangeHash(open.hashes);
      terms.push(open.term);
    }
    open = undefined;
  };
  chunks.forEach((c, i) => {
    const at = locate(c.hash, i);
    const same =
      open &&
      open.term.end === at.index &&
      open.term.xorbHash.every((b, k) => b === at.xorbHash[k]);
    if (!same) {
      close();
      open = {
        term: { xorbHash: at.xorbHash, bytes: 0, start: at.index, end: at.index },
        hashes: [],
      };
    }
    const o = open as { term: FileTerm; hashes: Uint8Array[] };
    o.term.end++;
    o.term.bytes += c.length;
    o.hashes.push(c.hash);
  });
  close();
  return terms;
}

/**
 * What a reconstruction checks, from a shard: the chunk hashes its CAS section lists (keyed ones
 * compared keyed), and the verification hashes of the file `fileHash`'s terms (File Info section),
 * a term of the answer matched to the file's term with the same xorb and chunk range, in order.
 *
 * - `wholeFile`: the answer must be the file itself: exactly its terms, each checked, none
 *   missing or extra (not for range requests, whose terms may start mid-file or be narrowed).
 * - `strict`: a chunk of a xorb the shard does not list fails instead of passing unchecked.
 *
 * A chunk past the end of a xorb the shard lists fails either way: the shard says it has no such
 * chunk. One verifier per reconstruction: it walks the file's terms in order.
 */
export function verifierFromShard(
  shard: Shard,
  fileHash?: Uint8Array,
  o: { wholeFile?: boolean; strict?: boolean } = {},
): ReconstructionVerifier {
  if (shard.chunkHashesKeyed && (!shard.footer?.chunkHashKey || isZero(shard.footer.chunkHashKey)))
    throw new Error("shard: keyed chunk hashes without the footer key");
  const key = shard.chunkHashesKeyed ? shard.footer?.chunkHashKey : undefined;
  const xorbs = new Map(shard.xorbs.map((x) => [hashToString(x.xorbHash), x]));
  const file = fileHash
    ? shard.files.find((f) => f.fileHash.every((b, i) => b === fileHash[i]))
    : undefined;
  if (fileHash && !file) throw new Error("shard: the file is not in this shard");
  if (o.wholeFile && !file) throw new Error("shard: wholeFile needs the file's hash");
  const terms = (file?.terms ?? []).map((t) => ({ ...t, xorb: hashToString(t.xorbHash) }));
  let cursor = 0; // file terms already matched: an answer lists them in file order
  return {
    chunk: (xorb, index, hash) => {
      const x = xorbs.get(xorb.toLowerCase());
      if (!x) return o.strict ? false : undefined;
      const want = x.chunks[index]?.hash;
      if (!want) return false;
      const got = key ? keyedChunkHash(hash, key) : hash;
      return got.every((b, i) => b === want[i]);
    },
    rangeHash: (term) => {
      for (let k = cursor; k < terms.length; k++) {
        const t = terms[k] as (typeof terms)[number];
        if (t.xorb === term.xorb && t.start === term.start && t.end === term.end) {
          cursor = k + 1;
          return t.rangeHash;
        }
      }
      return undefined;
    },
    done: o.wholeFile
      ? (seen) => {
          const same =
            seen.length === terms.length &&
            seen.every((s, k) => {
              const t = terms[k] as (typeof terms)[number];
              return s.xorb === t.xorb && s.start === t.start && s.end === t.end && t.rangeHash;
            });
          return same
            ? undefined
            : `the answer's ${seen.length} terms are not the file's ${terms.length} (each with its verification hash)`;
        }
      : undefined,
  };
}
