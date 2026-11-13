import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GEAR_TABLE } from "../src/gear-table.js";
import { lz4BlockEncode, lz4FrameDecode, lz4FrameEncode, xxh32 } from "../src/lz4.js";
import {
  dedupeIndex,
  keyedChunkHash,
  metadataSha256,
  readShard,
  type Shard,
  termsFor,
  verifierFromShard,
  writeShard,
} from "../src/shard.js";
import {
  bg4Regroup,
  type ChunkRef,
  chunkHash,
  chunkStream,
  fileHash,
  hashFromString,
  hashToString,
  type ReconstructionAnswer,
  type ReconstructionVerifier,
  rangeHash,
  reconstruct,
  writeXorb,
  XetIntegrityError,
  XORB_MAX_CHUNKS,
  xorbHash,
} from "../src/xet.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "../fixtures", name), "utf8");
const fixtureBytes = (name: string) =>
  new Uint8Array(readFileSync(join(here, "../fixtures", name)));
const CSV = "Electric_Vehicle_Population_Data_20250917.csv";
const XORB = "eea25d6ee393ccae385820daed127b96ef0ea034dfb7cf6da3a950ce334b7632";
const referenceChunks = (): ChunkRef[] =>
  fixture(`${CSV}.chunks`)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, length] = line.split(" ") as [string, string];
      return { hash: hashFromString(hash), length: Number(length) };
    });

/** the dataset revision the fixtures come from, and the xorb's SHA-256 there */
const REVISION = "c4aa3a3f15b1395fff5ce934784bf6c8f2d62de8";
const XORB_SHA256 = "e72f4e05b9c4b96f1c6b2213d93de00ab943585a2f7c049fd127ba72ec1ff413";
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * The reference xorb, downloaded once from the pinned revision of the specification's dataset into
 * `XET_REFERENCE_CACHE` (or the temp directory): written to a private file, checked by SHA-256, then renamed into place (so a
 * parallel run never reads a partial file). Offline, this fails with the URL it needs.
 */
function referenceXorb(): string {
  // CI keeps this directory in its cache (keyed by the SHA-256): the network only on a cache miss
  const dir = process.env.XET_REFERENCE_CACHE || tmpdir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `x11-${XORB_SHA256}.xorb`);
  if (existsSync(path) && sha256(path) === XORB_SHA256) return path;
  const url = `https://huggingface.co/datasets/xet-team/xet-spec-reference-files/resolve/${REVISION}/${XORB}.xorb`;
  const part = `${path}.${process.pid}.part`;
  try {
    execFileSync("curl", ["-sSfL", "--retry", "3", "-o", part, url]);
  } catch (e) {
    throw new Error(`the reference xorb could not be downloaded from ${url}: ${e}`);
  }
  if (sha256(part) !== XORB_SHA256) throw new Error(`${url}: unexpected content (SHA-256)`);
  renameSync(part, path);
  return path;
}

describe("H1 hash strings", () => {
  it("the specification's example, both ways", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
    const s = "07060504030201000f0e0d0c0b0a090817161514131211101f1e1d1c1b1a1918";
    expect(hashToString(bytes)).toBe(s);
    expect([...hashFromString(s)]).toEqual([...bytes]);
  });
});

describe("H2 aggregated hashes from the reference chunk list", () => {
  it("xorb hash, file hash and the full range's verification hash", () => {
    const reference = referenceChunks();
    expect(reference.length).toBe(796);
    expect(reference.reduce((n, c) => n + c.length, 0)).toBe(63_527_244);
    expect(hashToString(xorbHash(reference))).toBe(fixture(`${CSV}.xet-xorb-hash`).trim());
    expect(hashToString(fileHash(reference))).toBe(fixture(`${CSV}.xet-file-hash`).trim());
    expect(hashToString(rangeHash(reference.map((c) => c.hash)))).toBe(
      fixture(`${XORB}.xorb.range-hash`).trim(),
    );
  });
});

describe("H3 + H4 reconstruction from the recorded answer", () => {
  it("rebuilds the reference file: its chunks, chunk hashes and file hash, streaming", async () => {
    const reference = referenceChunks();
    const xorb = readFileSync(referenceXorb());
    const answer = JSON.parse(fixture("recon.recorded.json")) as ReconstructionAnswer;
    const fetched: string[] = [];
    // the recorded URLs name the xorb; a range is served in 1 MiB pieces, as a body would arrive
    const fetchRange = async function* (url: string, start: number, end: number) {
      fetched.push(`${url} ${start}-${end}`);
      expect(url).toBe(`xorb://${XORB}`);
      for (let at = start; at <= end; at += 1 << 20)
        yield xorb.subarray(at, Math.min(end + 1, at + (1 << 20)));
    };
    (globalThis as { gc?: () => void }).gc?.();
    const before = process.memoryUsage();
    let peak = 0;
    const got: ChunkRef[] = [];
    let size = 0;
    for await (const chunk of chunkStream(reconstruct(answer, fetchRange))) {
      got.push({ hash: chunkHash(chunk), length: chunk.length });
      size += chunk.length;
      // what is retained, after a collection (vitest runs with --expose-gc)
      if (got.length % 50 === 0) {
        (globalThis as { gc?: () => void }).gc?.();
        const m = process.memoryUsage();
        peak = Math.max(peak, m.heapUsed + m.arrayBuffers - before.heapUsed - before.arrayBuffers);
      }
    }
    expect(fetched).toEqual([`xorb://${XORB} 0-14737812`]);
    expect(size).toBe(63_527_244);
    expect(got.length).toBe(796);
    const wrong = got.findIndex(
      (c, i) =>
        c.length !== reference[i]?.length ||
        hashToString(c.hash) !== hashToString(reference[i]?.hash as Uint8Array),
    );
    expect(wrong).toBe(-1);
    expect(hashToString(fileHash(got))).toBe(fixture(`${CSV}.xet-file-hash`).trim());
    // the file is 63 MB; streaming retains a few chunks and fetched pieces, not the file
    expect(peak).toBeLessThan(8 * 1024 * 1024);
  }, 300_000);
});

describe("H6 range requests and ByteGrouping4", () => {
  it("a term over a chunk sub-range with an offset into it: the matching slice of the file", async () => {
    const xorb = readFileSync(referenceXorb());
    const answer = JSON.parse(fixture("recon.recorded.json")) as ReconstructionAnswer;
    const fetchRange = async function* (_url: string, start: number, end: number) {
      yield xorb.subarray(start, end + 1);
    };
    const collect = async (a: ReconstructionAnswer) => {
      const parts: Uint8Array[] = [];
      for await (const p of reconstruct(a, fetchRange)) parts.push(p);
      return Buffer.concat(parts);
    };
    const whole = await collect(answer);
    const ref = referenceChunks();
    const startByte = ref.slice(0, 10).reduce((n, c) => n + c.length, 0);
    const length = ref.slice(10, 20).reduce((n, c) => n + c.length, 0);
    const term = { ...answer.terms[0], unpacked_length: length, range: { start: 10, end: 20 } };
    const ranged = await collect({
      ...answer,
      offset_into_first_range: 12_345,
      terms: [term],
    } as ReconstructionAnswer);
    expect(ranged.equals(whole.subarray(startByte + 12_345, startByte + length))).toBe(true);
  }, 300_000);

  it("ByteGrouping4: groups split as xet-core's bg4_split_together come back in order", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 1000, 1001, 1002, 1003]) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      // bg4_split_together: bytes 4i+g into group g, the groups one after another
      const groups = [0, 1, 2, 3].map((g) => data.filter((_, i) => i % 4 === g));
      const grouped = Uint8Array.from(groups.flatMap((g) => [...g]));
      expect([...bg4Regroup(grouped)], `${n}`).toEqual([...data]);
    }
  });
});

/** the specification's chunker, literally: every byte hashed (BigInt), the mask tested from 8 KiB */
function specLengths(data: Uint8Array): number[] {
  const MASK = 0xffff000000000000n;
  const M = (1n << 64n) - 1n;
  const out: number[] = [];
  let h = 0n;
  let size = 0;
  for (const b of data) {
    h = ((h << 1n) + (GEAR_TABLE[b] as bigint)) & M;
    size++;
    if ((size >= 8192 && (h & MASK) === 0n) || size >= 131072) {
      out.push(size);
      h = 0n;
      size = 0;
    }
  }
  if (size) out.push(size);
  return out;
}

describe("H7 chunk boundaries at the minimum size, against the specification's own steps", () => {
  /** 64 bytes after which the hash has its top 16 bits clear: a candidate boundary */
  function matchingWindow(): Uint8Array {
    for (let seed = 1; ; seed++) {
      const w = new Uint8Array(64);
      let x = seed;
      for (let i = 0; i < 64; i++) {
        x = (x * 1103515245 + 12345) >>> 0;
        w[i] = x >>> 24;
      }
      let h = 0n;
      for (const b of w) h = ((h << 1n) + (GEAR_TABLE[b] as bigint)) & ((1n << 64n) - 1n);
      if (h >> 48n === 0n) return w;
    }
  }

  it("a match one byte before 8 KiB is no boundary; one at 8 KiB is", async () => {
    const w = matchingWindow();
    for (const end of [8191, 8192, 8193]) {
      // filler that the window's 64 bytes wash out, then the window ending at byte `end`
      const data = new Uint8Array(end + 20_000);
      for (let i = 0; i < data.length; i++) data[i] = (i * 131 + 7) & 255;
      data.set(w, end - 64);
      const ours: number[] = [];
      for await (const c of chunkStream([data] as unknown as AsyncIterable<Uint8Array>))
        ours.push(c.length);
      expect(ours, `window ending at ${end}`).toEqual(specLengths(data));
    }
  }, 120_000);
});

describe("H8 review cases", () => {
  const answerOf = (): ReconstructionAnswer => JSON.parse(fixture("recon.recorded.json"));

  it("the fetched body is closed when a term ends before its fetch range; no chunk past the term is read", async () => {
    const xorb = readFileSync(referenceXorb());
    let closed = 0;
    let served = 0;
    const fetchRange = async function* (_url: string, start: number, end: number) {
      try {
        for (let at = start; at <= end; at += 4096) {
          served = at + 4096;
          yield xorb.subarray(at, Math.min(end + 1, at + 4096));
        }
      } finally {
        closed++;
      }
    };
    const answer = answerOf();
    const ref = referenceChunks();
    const length = ref.slice(0, 3).reduce((n, c) => n + c.length, 0);
    const term = { ...answer.terms[0], unpacked_length: length, range: { start: 0, end: 3 } };
    let size = 0;
    for await (const p of reconstruct(
      { ...answer, terms: [term] } as ReconstructionAnswer,
      fetchRange,
    ))
      size += p.length;
    expect(size).toBe(length);
    expect(closed).toBe(1);
    // the 4th chunk's header starts where the 3rd chunk ends: nothing far past it was pulled
    let end3 = 0;
    for (let k = 0; k < 3; k++)
      end3 +=
        8 +
        ((xorb[end3 + 1] as number) |
          ((xorb[end3 + 2] as number) << 8) |
          ((xorb[end3 + 3] as number) << 16));
    expect(served).toBeLessThanOrEqual(end3 + 4096);
  }, 120_000);

  it("a fetch range that takes in the xorb's tail (XETB) after its last chunk", async () => {
    const xorb = readFileSync(referenceXorb());
    const answer = answerOf();
    const entry = answer.fetch_info[XORB]?.[0];
    if (entry) entry.url_range = { start: 0, end: xorb.length - 1 };
    const fetchRange = async function* (_url: string, start: number, end: number) {
      yield xorb.subarray(start, end + 1);
    };
    let size = 0;
    for await (const p of reconstruct(answer, fetchRange)) size += p.length;
    expect(size).toBe(63_527_244);
  }, 120_000);

  it("a requested length truncates the last term", async () => {
    const xorb = readFileSync(referenceXorb());
    const fetchRange = async function* (_url: string, start: number, end: number) {
      yield xorb.subarray(start, end + 1);
    };
    let size = 0;
    for await (const p of reconstruct(answerOf(), fetchRange, { length: 1_000_003 }))
      size += p.length;
    expect(size).toBe(1_000_003);
  }, 120_000);

  /** an LZ4 frame put together by hand */
  function frame(
    blocks: { bytes: number[]; raw?: boolean }[],
    o: {
      independent?: boolean;
      blockChecksum?: boolean;
      contentSize?: number;
      contentChecksum?: boolean;
      endMark?: boolean;
    } = {},
  ): Uint8Array {
    const flg =
      0x40 |
      (o.independent ? 0x20 : 0) |
      (o.blockChecksum ? 0x10 : 0) |
      (o.contentSize !== undefined ? 0x08 : 0) |
      (o.contentChecksum ? 0x04 : 0);
    const out = [0x04, 0x22, 0x4d, 0x18, flg, 0x40];
    if (o.contentSize !== undefined)
      for (let i = 0; i < 8; i++) out.push(i === 0 ? o.contentSize : 0);
    out.push(0x00); // header checksum (not checked)
    const u32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    for (const b of blocks) {
      out.push(...u32(b.bytes.length | (b.raw ? 0x80000000 : 0)), ...b.bytes);
      if (o.blockChecksum) out.push(0, 0, 0, 0);
    }
    if (o.endMark !== false) out.push(0, 0, 0, 0);
    if (o.contentChecksum) out.push(0, 0, 0, 0);
    return Uint8Array.from(out);
  }
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const lits = (s: string) => [s.length << 4, ...new TextEncoder().encode(s)]; // a literals-only block

  it("LZ4 frames: uncompressed and linked blocks, content size, checksums", () => {
    expect(
      text(
        lz4FrameDecode(frame([{ bytes: [...new TextEncoder().encode("plain")], raw: true }]), 5),
      ),
    ).toBe("plain");
    // block 2 starts with a match 4 bytes back into block 1 ("abcd"), then a literal
    const linked = frame([{ bytes: lits("abcd") }, { bytes: [0x00, 4, 0, ...lits("Z")] }]);
    expect(text(lz4FrameDecode(linked, 9))).toBe("abcdabcdZ");
    const all = frame([{ bytes: lits("hello") }], {
      contentSize: 5,
      blockChecksum: true,
      contentChecksum: true,
    });
    expect(text(lz4FrameDecode(all, 5))).toBe("hello");
  });

  it("LZ4 frames that lie are refused", () => {
    // literals running past their block, padded to the expected size
    expect(() => lz4FrameDecode(frame([{ bytes: [0xf0, 0x0a, 0x41] }]), 25)).toThrow(/lz4/);
    // no end mark
    expect(() => lz4FrameDecode(frame([{ bytes: lits("abc") }], { endMark: false }), 3)).toThrow(
      /lz4/,
    );
    // independent blocks: a match into the previous block
    expect(() =>
      lz4FrameDecode(
        frame([{ bytes: lits("abcd") }, { bytes: [0x00, 4, 0, ...lits("Z")] }], {
          independent: true,
        }),
        9,
      ),
    ).toThrow(/lz4/);
  });

  it("random data in every piece size chunks as the specification's chunker does", async () => {
    let x = 12345;
    const data = new Uint8Array(1_500_000);
    for (let i = 0; i < data.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      data[i] = x & 255;
    }
    const want = specLengths(data);
    for (const piece of [1, 7, 8127, 8128, 65_536, 131_072, 1_048_579]) {
      const src = (async function* () {
        for (let at = 0; at < data.length; at += piece) yield data.subarray(at, at + piece);
      })();
      const got: number[] = [];
      for await (const c of chunkStream(src)) got.push(c.length);
      expect(got, `pieces of ${piece}`).toEqual(want);
    }
  }, 300_000);
});

// ---------------------------------------------------------------- X11b: shards

/** the reference CSV's SHA-256, from the file rebuilt out of the reference xorb (as H3 does) */
let csvSha256: Uint8Array | undefined;
async function referenceSha256(): Promise<Uint8Array> {
  if (csvSha256) return csvSha256;
  const xorb = readFileSync(referenceXorb());
  const answer = JSON.parse(fixture("recon.recorded.json")) as ReconstructionAnswer;
  const h = createHash("sha256");
  for await (const p of reconstruct(answer, async function* (_u, start, end) {
    yield xorb.subarray(start, end + 1);
  }))
    h.update(p);
  csvSha256 = metadataSha256(new Uint8Array(h.digest()));
  return csvSha256;
}
const SHARDS = {
  base: `${CSV}.shard`,
  verification: `${CSV}.shard.verification`,
  upload: `${CSV}.shard.verification-no-footer`,
  dedupe: `${CSV}.shard.dedupe`,
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("U1 (X11b) shards written byte for byte as the specification's reference shards", () => {
  it("base, with verification, the upload form (no footer), and a global-dedupe answer", async () => {
    const chunks = referenceChunks();
    const xorb = hashFromString(XORB);
    const file = hashFromString(fixture(`${CSV}.xet-file-hash`).trim());
    const range = hashFromString(fixture(`${XORB}.xorb.range-hash`).trim());
    const sha256 = await referenceSha256();
    const term = { xorbHash: xorb, bytes: 63_527_244, start: 0, end: 796 };
    const xorbs = [{ xorbHash: xorb, chunks }];
    // the footers' timestamps and the dedupe key are the reference shards' own inputs
    const want: Record<keyof typeof SHARDS, Shard> = {
      base: {
        files: [{ fileHash: file, terms: [term], sha256 }],
        xorbs,
        footer: { creationTimestamp: 1758141909 },
      },
      verification: {
        files: [{ fileHash: file, terms: [{ ...term, rangeHash: range }], sha256 }],
        xorbs,
        footer: { keyExpiry: 1760478341 },
      },
      upload: {
        files: [{ fileHash: file, terms: [{ ...term, rangeHash: range }], sha256 }],
        xorbs,
      },
      dedupe: {
        files: [],
        xorbs,
        footer: {
          chunkHashKey: hashFromString("12345678".repeat(8)),
          creationTimestamp: 1758663941,
          keyExpiry: 1760478341,
        },
      },
    };
    for (const k of Object.keys(SHARDS) as (keyof typeof SHARDS)[])
      expect(hex(writeShard(want[k])), k).toBe(hex(fixtureBytes(SHARDS[k])));
  }, 300_000);

  it("each reference shard read and written again is the same bytes", () => {
    for (const name of Object.values(SHARDS)) {
      const bytes = fixtureBytes(name);
      const shard = readShard(bytes);
      expect(hex(writeShard(shard)), name).toBe(hex(bytes));
    }
    const dedupe = readShard(fixtureBytes(SHARDS.dedupe));
    expect(dedupe.files).toEqual([]);
    expect(hashToString(dedupe.footer?.chunkHashKey as Uint8Array)).toBe("12345678".repeat(8));
  });
});

describe("U2 (X11b) an upload deduplicated against a global-dedupe shard", () => {
  it("every chunk found by its keyed hash; the terms make the reference upload shard", async () => {
    const chunks = referenceChunks();
    const locate = dedupeIndex([readShard(fixtureBytes(SHARDS.dedupe))]);
    chunks.forEach((c, i) => {
      const at = locate(c.hash);
      expect(at && hashToString(at.xorbHash), `chunk ${i}`).toBe(XORB);
      expect(at?.index).toBe(i);
    });
    // a chunk no shard holds; and the dedupe shard does not hold plain hashes
    expect(locate(new Uint8Array(32).fill(7))).toBeUndefined();
    const stored = readShard(fixtureBytes(SHARDS.dedupe)).xorbs[0]?.chunks[0]?.hash as Uint8Array;
    expect(hex(stored)).toBe(
      hex(keyedChunkHash(chunks[0]?.hash as Uint8Array, hashFromString("12345678".repeat(8)))),
    );
    const terms = termsFor(chunks, (h) => {
      const at = locate(h);
      if (!at) throw new Error("not deduplicated");
      return at;
    });
    expect(terms.length).toBe(1);
    expect(hashToString(terms[0]?.rangeHash as Uint8Array)).toBe(
      fixture(`${XORB}.xorb.range-hash`).trim(),
    );
    const upload = writeShard({
      files: [{ fileHash: fileHash(chunks), terms, sha256: await referenceSha256() }],
      xorbs: [{ xorbHash: xorbHash(chunks), chunks }],
    });
    expect(hex(upload)).toBe(hex(fixtureBytes(SHARDS.upload)));
  }, 300_000);

  it("terms split where the chunks leave a xorb or skip an index; each with its own range hash", () => {
    const chunks = referenceChunks().slice(0, 10);
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    // chunks 0-3 in a at 5..8, 4-5 in b at 0..1, 6 in a at 20, 7-9 in a at 21..23
    const where = [5, 6, 7, 8, 0, 1, 20, 21, 22, 23];
    const terms = termsFor(chunks, (_h, i) => ({
      xorbHash: i >= 4 && i < 6 ? b : a,
      index: where[i] as number,
    }));
    expect(terms.map((t) => [t.xorbHash[0], t.start, t.end])).toEqual([
      [1, 5, 9],
      [2, 0, 2],
      [1, 20, 24],
    ]);
    expect(terms.map((t) => t.bytes)).toEqual([
      chunks.slice(0, 4).reduce((n, c) => n + c.length, 0),
      chunks.slice(4, 6).reduce((n, c) => n + c.length, 0),
      chunks.slice(6).reduce((n, c) => n + c.length, 0),
    ]);
    expect(hex(terms[1]?.rangeHash as Uint8Array)).toBe(
      hex(rangeHash(chunks.slice(4, 6).map((c) => c.hash))),
    );
  });

  it("refuses: verification for some terms only, a damaged tag, a truncated shard, bytes after an unfooted shard", () => {
    const chunks = referenceChunks().slice(0, 2);
    const t = { xorbHash: new Uint8Array(32), bytes: 1, start: 0, end: 1 };
    expect(() =>
      writeShard({
        files: [
          { fileHash: new Uint8Array(32), terms: [{ ...t, rangeHash: new Uint8Array(32) }] },
          { fileHash: new Uint8Array(32), terms: [t] },
        ],
        xorbs: [],
      }),
    ).toThrow(/some terms only/);
    const good = writeShard({ files: [], xorbs: [{ xorbHash: new Uint8Array(32), chunks }] });
    const bad = good.slice();
    bad[3] = (bad[3] as number) ^ 1;
    expect(() => readShard(bad)).toThrow(/header tag/);
    expect(() => readShard(good.subarray(0, good.length - 1))).toThrow(/truncated/);
    const extra = new Uint8Array(good.length + 1);
    extra.set(good);
    expect(() => readShard(extra)).toThrow(/after the CAS section/);
  });
});

// ---------------------------------------------------------------- X11b: xorbs written

/** a xorb's chunks read back through `reconstruct` (one term, one fetch of the whole xorb) */
async function readBack(xorb: Uint8Array, count: number, bytes: number): Promise<Uint8Array[]> {
  const hash = "00".repeat(32);
  const answer: ReconstructionAnswer = {
    offset_into_first_range: 0,
    terms: [{ hash, unpacked_length: bytes, range: { start: 0, end: count } }],
    fetch_info: {
      [hash]: [
        {
          range: { start: 0, end: count },
          url: "xorb://ours",
          url_range: { start: 0, end: xorb.length - 1 },
        },
      ],
    },
  };
  const out: Uint8Array[] = [];
  for await (const c of chunkStream(
    reconstruct(answer, async function* (_u, start, end) {
      yield xorb.subarray(start, end + 1);
    }),
  ))
    out.push(c);
  return out;
}

/**
 * LZ4's end-of-block rules, which decoders may rely on (ours does not check them): the last 5
 * bytes are literals, no match starts within the last 12, offsets reach only bytes already
 * written; and the block decodes to `data`.
 */
function checkBlockRules(block: Uint8Array, data: Uint8Array, name: string) {
  const out = new Uint8Array(data.length);
  let at = 0;
  let o = 0;
  while (at < block.length) {
    const token = block[at++] as number;
    let lit = token >> 4;
    if (lit === 15) for (let b = 255; b === 255; lit += b) b = block[at++] as number;
    out.set(block.subarray(at, at + lit), o);
    at += lit;
    o += lit;
    if (at >= block.length) break;
    const offset = (block[at] as number) | ((block[at + 1] as number) << 8);
    at += 2;
    let len = (token & 15) + 4;
    if ((token & 15) === 15) for (let b = 255; b === 255; len += b) b = block[at++] as number;
    // plain comparisons (thousands per block); an assertion only on a failure
    if (o > data.length - 12) expect.fail(`${name}: a match starts within the last 12 bytes`);
    if (offset < 1 || offset > o) expect.fail(`${name}: offset ${offset} at ${o}`);
    for (let i = 0; i < len; i++) out[o + i] = out[o - offset + i] as number;
    o += len;
    if (o > data.length - 5) expect.fail(`${name}: a match covers the last 5 bytes`);
  }
  if (o !== data.length || !Buffer.from(out).equals(Buffer.from(data)))
    expect.fail(`${name}: does not decode back`);
}

describe("U3 (X11b) xorbs written: LZ4 frames our decoder and the reference chunking read back", () => {
  it("xxHash32 matches its published values (the frame's header checksum)", () => {
    const t = (s: string) => xxh32(new TextEncoder().encode(s));
    expect(t("")).toBe(0x02cc5d05);
    expect(t("abc")).toBe(0x32d153ff);
    expect(t("Nobody inspects the spammish repetition")).toBe(0xe2293b2f);
  });

  it("LZ4 frames round trip: empty, tiny, incompressible, runs, matches up to 64 KiB back", () => {
    const rand = (n: number, seed: number) => {
      const out = new Uint8Array(n);
      let x = seed;
      for (let i = 0; i < n; i++) {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        out[i] = x >>> 24;
      }
      return out;
    };
    const far = new Uint8Array(200_000);
    far.set(rand(1000, 3), 0);
    far.set(rand(1000, 3), 65_000); // 65,000 back: within the 16-bit offset
    far.set(rand(1000, 3), 140_000); // 75,000 after the second: too far, found again from it
    const cases: [string, Uint8Array][] = [
      ["empty", new Uint8Array(0)],
      ...[1, 5, 12, 13, 17].map((n): [string, Uint8Array] => [`${n} bytes`, rand(n, n)]),
      ["incompressible 128 KiB", rand(128 * 1024, 7)],
      ["a run of one byte", new Uint8Array(100_000).fill(42)],
      ["text", new TextEncoder().encode("the quick brown fox ".repeat(5000))],
      ["far repeats", far],
      ["long literals then a match", new Uint8Array([...rand(300, 9), ...rand(300, 9)])],
    ];
    for (const [name, data] of cases) {
      const frame = lz4FrameEncode(data);
      expect(Buffer.from(lz4FrameDecode(frame, data.length)).equals(Buffer.from(data)), name).toBe(
        true,
      );
    }
    for (const [name, data] of cases) checkBlockRules(lz4BlockEncode(data), data, name);
    expect(lz4BlockEncode(new Uint8Array(100_000).fill(42)).length).toBeLessThan(500);
    expect(lz4FrameEncode(rand(4096, 1)).length).toBeLessThanOrEqual(4096 + 15); // stored
  });

  it("the reference file's 796 chunks in a xorb we write: read back, same hashes, about the reference's size", async () => {
    const xorb = readFileSync(referenceXorb());
    const answer = JSON.parse(fixture("recon.recorded.json")) as ReconstructionAnswer;
    const chunks: Uint8Array[] = [];
    for await (const c of chunkStream(
      reconstruct(answer, async function* (_u, start, end) {
        yield xorb.subarray(start, end + 1);
      }),
    ))
      chunks.push(c);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const refs = referenceChunks();
    for (const compression of ["lz4", "bg4-lz4", "none"] as const) {
      const ours = writeXorb(chunks, { compression });
      const back = await readBack(ours, chunks.length, total);
      expect(back.length, compression).toBe(796);
      const wrong = back.findIndex(
        (c, i) => hashToString(chunkHash(c)) !== hashToString(refs[i]?.hash as Uint8Array),
      );
      expect(wrong, compression).toBe(-1);
      if (compression === "none") expect(ours.length).toBe(total + 8 * 796);
      // the reference xorb (xet-core's LZ4, then its 4-byte tail) is 14,737,817 bytes
      if (compression === "lz4") {
        expect(ours.length).toBeLessThan(14_737_817 * 1.25);
        console.log(`U3: our LZ4 xorb ${ours.length} bytes, the reference's 14,737,817`);
      }
    }
    expect(hashToString(xorbHash(refs))).toBe(XORB);
  }, 300_000);

  it("refuses more chunks than a xorb may hold", () => {
    expect(() =>
      writeXorb(Array.from({ length: XORB_MAX_CHUNKS + 1 }, () => new Uint8Array(1))),
    ).toThrow(/at most 8192/);
  });
});

describe("U4 (review of #121) frames, shards and dedupe beyond the reference files", () => {
  const rand = (n: number, seed: number, alphabet = 256) => {
    const out = new Uint8Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out[i] = (x >>> 24) % alphabet;
    }
    return out;
  };

  it("the empty frame's bytes (the header checksum as liblz4 writes it for 60 70)", () => {
    expect(Buffer.from(lz4FrameEncode(new Uint8Array(0))).toString("hex")).toBe(
      "04224d1860707300000000",
    );
  });

  it("a chunk over 4 MiB: blocks of at most 4 MiB; a block past the frame's maximum is refused", () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 4096) big.set(rand(4096, at % 65536, 16), at);
    const frame = lz4FrameEncode(big);
    let at = 7;
    const sizes: number[] = [];
    for (;;) {
      const word = new DataView(frame.buffer, frame.byteOffset).getUint32(at, true);
      if (word === 0) break;
      sizes.push(word & 0x7fffffff);
      at += 4 + (word & 0x7fffffff);
    }
    expect(sizes.length).toBe(2);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Buffer.from(lz4FrameDecode(frame, big.length)).equals(Buffer.from(big))).toBe(true);
    // a frame declaring 64 KiB blocks (BD 0x40) that holds a 70,000-byte stored block
    const lying = new Uint8Array(7 + 4 + 70_000 + 4);
    lying.set([0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x00]);
    new DataView(lying.buffer).setUint32(7, (70_000 | 0x80000000) >>> 0, true);
    expect(() => lz4FrameDecode(lying, 70_000)).toThrow(/maximum/);
  });

  it("2,000 random inputs: every block keeps LZ4's end-of-block rules and decodes back", () => {
    for (let k = 0; k < 2000; k++) {
      const n = (k * 7919) % 20_000;
      const data = rand(n, k + 1, 2 + (k % 6));
      checkBlockRules(lz4BlockEncode(data), data, `input ${k} (${n} bytes)`);
    }
  });

  it("refuses an empty chunk and more than 64 MiB in one xorb", () => {
    expect(() => writeXorb([new Uint8Array(0)])).toThrow(/empty chunk/);
    const mib = new Uint8Array(1024 * 1024);
    expect(() =>
      writeXorb(
        Array.from({ length: 65 }, () => mib),
        { compression: "none" },
      ),
    ).toThrow(/64 MiB/);
  });

  it("several files and xorbs, a file of no terms, chunk flags and sizes on disk: round trip and footer totals", () => {
    const h = (b: number) => new Uint8Array(32).fill(b);
    const shard: Shard = {
      files: [
        { fileHash: h(1), terms: [] },
        {
          fileHash: h(2),
          terms: [
            { xorbHash: h(10), bytes: 7, start: 0, end: 2 },
            { xorbHash: h(11), bytes: 8, start: 1, end: 2 },
          ],
          sha256: h(3),
        },
      ],
      xorbs: [
        {
          xorbHash: h(10),
          chunks: [
            { hash: h(20), length: 3 },
            { hash: h(21), length: 4 },
          ],
          bytesOnDisk: 30,
          chunkFlags: [0x80000000, 1],
        },
        {
          xorbHash: h(11),
          chunks: [
            { hash: h(22), length: 0 },
            { hash: h(23), length: 8 },
          ],
          bytesOnDisk: 17,
          chunkFlags: [0, 0],
        },
      ],
      footer: { creationTimestamp: 5 },
    };
    const bytes = writeShard(shard);
    const back = readShard(bytes);
    expect(hex(writeShard(back))).toBe(hex(bytes));
    expect(back.xorbs.map((x) => x.chunkFlags)).toEqual([
      [0x80000000, 1],
      [0, 0],
    ]);
    expect(back.xorbs.map((x) => x.bytesOnDisk)).toEqual([30, 17]);
    expect(back.files[0]?.terms).toEqual([]);
    const f = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 200);
    const u64 = (at: number) => Number(f.getBigUint64(at, true));
    expect([u64(8), u64(168), u64(176), u64(184), u64(192)]).toEqual([
      48,
      47, // on disk: 30 + 17
      15, // materialized: the terms' bytes
      15, // stored: the chunks' bytes
      bytes.length - 200,
    ]);
    // a hostile entry count is refused before anything is read for it
    const hostile = bytes.slice();
    new DataView(hostile.buffer).setUint32(48 + 36, 0xffffffff, true);
    expect(() => readShard(hostile)).toThrow(/truncated/);
  });

  it("dedupe over plain, keyed and mixed shards; duplicate chunks start new terms; keyed hashes stay out of uploads", () => {
    const chunks = referenceChunks().slice(0, 6);
    const key = hashFromString("12345678".repeat(8));
    const a = new Uint8Array(32).fill(0xa);
    const b = new Uint8Array(32).fill(0xb);
    const plain: Shard = { files: [], xorbs: [{ xorbHash: a, chunks: chunks.slice(0, 3) }] };
    const keyed = readShard(
      writeShard({
        files: [],
        xorbs: [{ xorbHash: b, chunks: chunks.slice(3) }],
        footer: { chunkHashKey: key },
      }),
    );
    const locate = dedupeIndex([plain, keyed]);
    chunks.forEach((c, i) => {
      const at = locate(c.hash);
      expect(at?.xorbHash[0], `chunk ${i}`).toBe(i < 3 ? 0xa : 0xb);
      expect(at?.index).toBe(i % 3);
    });
    // an in-memory shard with a footer key holds plain hashes until written
    const unwritten: Shard = {
      files: [],
      xorbs: [{ xorbHash: b, chunks: chunks.slice(3) }],
      footer: { chunkHashKey: key },
    };
    expect(dedupeIndex([unwritten])(chunks[4]?.hash as Uint8Array)?.index).toBe(1);
    // the same chunk twice: two terms (an index does not repeat within one term)
    const twice = [chunks[0], chunks[0]] as ChunkRef[];
    expect(termsFor(twice, () => ({ xorbHash: a, index: 0 })).length).toBe(2);
    // keyed hashes written without their key would reach the server as if plain
    expect(() => writeShard({ ...keyed, footer: undefined })).toThrow(/without the footer key/);
  });
});

describe("U5 (X11b) reconstruction checks each chunk against a shard's hashes as it streams", () => {
  /** the reference file's chunks, decoded once */
  let chunks: Uint8Array[] | undefined;
  const referenceChunkData = async () => {
    if (chunks) return chunks;
    const xorb = readFileSync(referenceXorb());
    const answer = JSON.parse(fixture("recon.recorded.json")) as ReconstructionAnswer;
    const out: Uint8Array[] = [];
    for await (const c of chunkStream(
      reconstruct(answer, async function* (_u, start, end) {
        yield xorb.subarray(start, end + 1);
      }),
    ))
      out.push(c);
    chunks = out;
    return out;
  };
  /** an answer over all 796 chunks of `xorb` (named as the reference xorb), fetched in 1 MiB pieces */
  const run = async (xorb: Uint8Array, verify?: ReconstructionVerifier) => {
    const answer: ReconstructionAnswer = {
      offset_into_first_range: 0,
      terms: [{ hash: XORB, unpacked_length: 63_527_244, range: { start: 0, end: 796 } }],
      fetch_info: {
        [XORB]: [
          {
            range: { start: 0, end: 796 },
            url: `xorb://${XORB}`,
            url_range: { start: 0, end: xorb.length - 1 },
          },
        ],
      },
    };
    let yielded = 0;
    let bytes = 0;
    try {
      for await (const p of reconstruct(
        answer,
        async function* (_u, start, end) {
          for (let at = start; at <= end; at += 1 << 20)
            yield xorb.subarray(at, Math.min(end + 1, at + (1 << 20)));
        },
        { verify },
      )) {
        yielded++;
        bytes += p.length;
      }
      return { yielded, bytes };
    } catch (e) {
      return { yielded, bytes, error: e as Error };
    }
  };
  /** the reference chunks stored uncompressed, chunk `k` with one byte changed (decodes fine) */
  const damaged = (all: Uint8Array[], k: number) => {
    const xorb = writeXorb(all, { compression: "none" });
    let at = 0;
    for (let i = 0; i < k; i++) at += 8 + (all[i] as Uint8Array).length;
    xorb[at + 8 + 1000] = (xorb[at + 8 + 1000] as number) ^ 0x20;
    return xorb;
  };

  it("the reference reconstruction passes, every chunk checked, with each reference shard", async () => {
    const xorb = new Uint8Array(readFileSync(referenceXorb()));
    for (const name of [SHARDS.base, SHARDS.verification, SHARDS.dedupe]) {
      const v = verifierFromShard(readShard(fixtureBytes(name)));
      let checked = 0;
      const r = await run(xorb, {
        chunk: (x, i, h) => {
          const ok = v.chunk?.(x, i, h);
          if (ok) checked++;
          return ok;
        },
      });
      expect(r.error, name).toBeUndefined();
      expect(r.bytes).toBe(63_527_244);
      expect(checked, name).toBe(796);
    }
  }, 300_000);

  it("a damaged chunk stops the stream at that chunk; unchecked, the damage passes silently", async () => {
    const all = await referenceChunkData();
    const bad = damaged(all, 300);
    const unchecked = await run(bad);
    expect(unchecked.error).toBeUndefined(); // decodes, wrong bytes, nothing notices
    expect(unchecked.yielded).toBe(796);
    for (const name of [SHARDS.base, SHARDS.dedupe]) {
      const r = await run(bad, verifierFromShard(readShard(fixtureBytes(name))));
      expect(r.error, name).toBeInstanceOf(XetIntegrityError);
      expect(r.error?.message).toMatch(/chunk 300 /);
      expect(r.yielded, name).toBe(300); // chunks 0-299 out, nothing from 300 on
    }
  }, 300_000);

  it("with the file's term verification hash only: caught when the term ends", async () => {
    const all = await referenceChunkData();
    const shard = readShard(fixtureBytes(SHARDS.verification));
    const file = hashFromString(fixture(`${CSV}.xet-file-hash`).trim());
    // one verifier per reconstruction (it walks the file's terms in order)
    const termOnly = () => ({ rangeHash: verifierFromShard(shard, file).rangeHash });
    const clean = await run(writeXorb(all, { compression: "none" }), termOnly());
    expect(clean.error).toBeUndefined();
    const r = await run(damaged(all, 700), termOnly());
    expect(r.error).toBeInstanceOf(XetIntegrityError);
    expect(r.error?.message).toMatch(/verification hash/);
    expect(r.yielded).toBe(796); // the term's bytes are out before its end is checked
    expect(() => verifierFromShard(shard, new Uint8Array(32))).toThrow(/not in this shard/);
  }, 300_000);

  it("a term inside its fetch range: its range hash covers its own chunks only", async () => {
    const xorb = new Uint8Array(readFileSync(referenceXorb()));
    const refs = referenceChunks();
    const bytes = refs.slice(100, 200).reduce((n, c) => n + c.length, 0);
    const answer: ReconstructionAnswer = {
      offset_into_first_range: 0,
      terms: [{ hash: XORB, unpacked_length: bytes, range: { start: 100, end: 200 } }],
      fetch_info: {
        [XORB]: [
          {
            range: { start: 0, end: 796 },
            url: `xorb://${XORB}`,
            url_range: { start: 0, end: xorb.length - 1 },
          },
        ],
      },
    };
    const go = async (expected: Uint8Array) => {
      let n = 0;
      for await (const p of reconstruct(
        answer,
        async function* (_u, start, end) {
          yield xorb.subarray(start, end + 1);
        },
        { verify: { rangeHash: () => expected } },
      ))
        n += p.length;
      return n;
    };
    expect(await go(rangeHash(refs.slice(100, 200).map((c) => c.hash)))).toBe(bytes);
    await expect(go(rangeHash(refs.slice(0, 200).map((c) => c.hash)))).rejects.toThrow(
      XetIntegrityError,
    );
  }, 300_000);

  it("chunks of a xorb the shard does not list are not checked", async () => {
    const all = await referenceChunkData();
    const other = verifierFromShard({ files: [], xorbs: [] });
    const r = await run(damaged(all, 5), other);
    expect(r.error).toBeUndefined();
  }, 300_000);
});

describe("U6 (review of #123) verification over several terms, range requests and partial shards", () => {
  // 8 chunks of about 1 KB in one xorb; a file of two terms, [0,4) and [4,8)
  const data = Array.from({ length: 8 }, (_, k) => {
    const c = new Uint8Array(1000 + k);
    let x = k + 1;
    for (let i = 0; i < c.length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      c[i] = x >>> 24;
    }
    return c;
  });
  const refs: ChunkRef[] = data.map((c) => ({ hash: chunkHash(c), length: c.length }));
  const xh = xorbHash(refs);
  const X = hashToString(xh);
  const bytesOf = (a: number, b: number) => refs.slice(a, b).reduce((n, c) => n + c.length, 0);
  const term = (a: number, b: number) => ({
    xorbHash: xh,
    bytes: bytesOf(a, b),
    start: a,
    end: b,
    rangeHash: rangeHash(refs.slice(a, b).map((c) => c.hash)),
  });
  const file = fileHash(refs);
  const shard: Shard = {
    files: [{ fileHash: file, terms: [term(0, 4), term(4, 8)] }],
    xorbs: [{ xorbHash: xh, chunks: refs }],
  };
  const xorbOf = (damage?: number) => {
    const x = writeXorb(data, { compression: "none" });
    if (damage !== undefined) {
      let at = 0;
      for (let k = 0; k < damage; k++) at += 8 + (data[k] as Uint8Array).length;
      x[at + 8 + 10] = (x[at + 8 + 10] as number) ^ 1;
    }
    return x;
  };
  /** an answer of `terms` ([start, end) of the xorb), named `name` */
  const go = async (
    terms: [number, number][],
    verify: ReconstructionVerifier | undefined,
    o: { damage?: number; name?: string; offset?: number; length?: number } = {},
  ) => {
    const xorb = xorbOf(o.damage);
    const name = o.name ?? X;
    const answer: ReconstructionAnswer = {
      offset_into_first_range: o.offset ?? 0,
      terms: terms.map(([a, b]) => ({
        hash: name,
        unpacked_length: bytesOf(a, b),
        range: { start: a, end: b },
      })),
      fetch_info: {
        [name]: [
          { range: { start: 0, end: 8 }, url: "x", url_range: { start: 0, end: xorb.length - 1 } },
        ],
      },
    };
    let n = 0;
    try {
      for await (const p of reconstruct(
        answer,
        async function* (_u, a, b) {
          yield xorb.subarray(a, b + 1);
        },
        { verify, length: o.length },
      ))
        n += p.length;
      return { n };
    } catch (e) {
      return { n, error: e as Error };
    }
  };
  const termsOnly = (o: { wholeFile?: boolean } = {}): ReconstructionVerifier => {
    const v = verifierFromShard(shard, file, o);
    return { rangeHash: v.rangeHash, done: v.done };
  };

  it("the whole file, both checks and wholeFile: passes; damage in its second term is caught", async () => {
    expect(
      (
        await go(
          [
            [0, 4],
            [4, 8],
          ],
          verifierFromShard(shard, file, { wholeFile: true }),
        )
      ).error,
    ).toBeUndefined();
    const r = await go(
      [
        [0, 4],
        [4, 8],
      ],
      termsOnly(),
      { damage: 6 },
    );
    expect(r.error).toBeInstanceOf(XetIntegrityError);
    expect(r.error?.message).toMatch(/4-8 does not match/);
  });

  it("range requests and other term splits: no false alarm on correct data; wholeFile refuses them", async () => {
    for (const terms of [
      [[4, 8]],
      [[5, 8]],
      [
        [0, 2],
        [2, 8],
      ],
      [
        [0, 4],
        [4, 6],
      ],
    ] as [number, number][][]) {
      expect((await go(terms, termsOnly())).error, JSON.stringify(terms)).toBeUndefined();
      expect(
        (await go(terms, termsOnly({ wholeFile: true }))).error,
        JSON.stringify(terms),
      ).toBeInstanceOf(XetIntegrityError);
    }
    // a range request over the second term is checked against it
    expect((await go([[4, 8]], termsOnly(), { damage: 5 })).error).toBeInstanceOf(
      XetIntegrityError,
    );
  });

  it("wholeFile: a dropped trailing term and an extra term are refused", async () => {
    expect((await go([[0, 4]], termsOnly({ wholeFile: true }))).error?.message).toMatch(
      /not the file's/,
    );
    expect(
      (
        await go(
          [
            [0, 4],
            [4, 8],
            [4, 8],
          ],
          termsOnly({ wholeFile: true }),
        )
      ).error,
    ).toBeInstanceOf(XetIntegrityError);
  });

  it("a length ending exactly at the file's end still checks its last term", async () => {
    const r = await go(
      [
        [0, 4],
        [4, 8],
      ],
      termsOnly({ wholeFile: true }),
      {
        damage: 6,
        length: bytesOf(0, 8),
      },
    );
    expect(r.error).toBeInstanceOf(XetIntegrityError);
    expect(
      (
        await go(
          [
            [0, 4],
            [4, 8],
          ],
          termsOnly({ wholeFile: true }),
          { length: bytesOf(0, 8) },
        )
      ).error,
    ).toBeUndefined();
  });

  it("an upper-case xorb name, a chunk past what the shard lists, an unlisted xorb under strict", async () => {
    const r = await go([[0, 8]], verifierFromShard(shard), { damage: 3, name: X.toUpperCase() });
    expect(r.error?.message).toMatch(/chunk 3 /);
    const short: Shard = { files: [], xorbs: [{ xorbHash: xh, chunks: refs.slice(0, 3) }] };
    expect((await go([[0, 8]], verifierFromShard(short))).error?.message).toMatch(/chunk 3 /);
    const none: Shard = { files: [], xorbs: [] };
    expect((await go([[0, 8]], verifierFromShard(none))).error).toBeUndefined();
    expect(
      (await go([[0, 8]], verifierFromShard(none, undefined, { strict: true }))).error?.message,
    ).toMatch(/chunk 0 /);
    expect(() => verifierFromShard({ ...shard, chunkHashesKeyed: true })).toThrow(
      /without the footer key/,
    );
  });

  it("a short term (fewer bytes than the answer says) is an integrity failure under verify", async () => {
    const xorb = xorbOf();
    const answer: ReconstructionAnswer = {
      offset_into_first_range: 0,
      terms: [{ hash: X, unpacked_length: bytesOf(0, 4) + 1, range: { start: 0, end: 4 } }],
      fetch_info: {
        [X]: [
          { range: { start: 0, end: 8 }, url: "x", url_range: { start: 0, end: xorb.length - 1 } },
        ],
      },
    };
    const consume = async (verify?: ReconstructionVerifier) => {
      for await (const _ of reconstruct(
        answer,
        async function* (_u, a, b) {
          yield xorb.subarray(a, b + 1);
        },
        { verify },
      ));
    };
    await expect(consume(verifierFromShard(shard))).rejects.toThrow(XetIntegrityError);
    await expect(consume()).rejects.toThrow(/expected/);
  });
});

describe("U7 (X11b) several terms of one fetch range in one request", () => {
  const data = Array.from({ length: 8 }, (_, k) => {
    const c = new Uint8Array(500 + k);
    let x = k + 11;
    for (let i = 0; i < c.length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      c[i] = x >>> 24;
    }
    return c;
  });
  const refs: ChunkRef[] = data.map((c) => ({ hash: chunkHash(c), length: c.length }));
  const xh = xorbHash(refs);
  const X = hashToString(xh);
  const bytesOf = (a: number, b: number) => refs.slice(a, b).reduce((n, c) => n + c.length, 0);
  const concat = (parts: Uint8Array[]) => Buffer.concat(parts.map((p) => Buffer.from(p)));
  /** fetch entries: [chunk range, as a list]; the xorb's byte offsets computed from the chunks */
  const offsets = [0];
  for (const c of data) offsets.push((offsets[offsets.length - 1] as number) + 8 + c.length);
  const entry = (a: number, b: number) => ({
    range: { start: a, end: b },
    url: `xorb://${a}-${b}`,
    url_range: { start: offsets[a] as number, end: (offsets[b] as number) - 1 },
  });
  const go = async (
    terms: [number, number][],
    entries: [number, number][],
    o: { damage?: number; offset?: number; length?: number; verify?: ReconstructionVerifier } = {},
  ) => {
    const xorb = writeXorb(data, { compression: "none" });
    if (o.damage !== undefined) {
      const at = (offsets[o.damage] as number) + 8 + 3;
      xorb[at] = (xorb[at] as number) ^ 1;
    }
    const answer: ReconstructionAnswer = {
      offset_into_first_range: o.offset ?? 0,
      terms: terms.map(([a, b]) => ({
        hash: X,
        unpacked_length: bytesOf(a, b),
        range: { start: a, end: b },
      })),
      fetch_info: { [X]: entries.map(([a, b]) => entry(a, b)) },
    };
    const fetches: string[] = [];
    const out: Uint8Array[] = [];
    let error: Error | undefined;
    try {
      for await (const p of reconstruct(
        answer,
        async function* (url, a, b) {
          fetches.push(url);
          yield xorb.subarray(a, b + 1);
        },
        { length: o.length, verify: o.verify },
      ))
        out.push(p);
    } catch (e) {
      error = e as Error;
    }
    return { fetches, out: concat(out), error };
  };
  const want = (terms: [number, number][]) => concat(terms.flatMap(([a, b]) => data.slice(a, b)));

  it("consecutive terms of one fetch range: one fetch, their bytes in order", async () => {
    const r = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 8]],
    );
    expect(r.fetches).toEqual(["xorb://0-8"]);
    expect(
      r.out.equals(
        want([
          [0, 4],
          [4, 8],
        ]),
      ),
    ).toBe(true);
  });

  it("a gap between terms: still one fetch; the chunks between are not output", async () => {
    const r = await go(
      [
        [0, 2],
        [5, 8],
      ],
      [[0, 8]],
    );
    expect(r.fetches).toEqual(["xorb://0-8"]);
    expect(
      r.out.equals(
        want([
          [0, 2],
          [5, 8],
        ]),
      ),
    ).toBe(true);
  });

  it("terms going backwards, a term twice, terms of different fetch ranges: a fetch each", async () => {
    expect(
      (
        await go(
          [
            [4, 8],
            [0, 4],
          ],
          [[0, 8]],
        )
      ).fetches.length,
    ).toBe(2);
    const twice = await go(
      [
        [0, 4],
        [0, 4],
      ],
      [[0, 8]],
    );
    expect(twice.fetches.length).toBe(2);
    expect(
      twice.out.equals(
        want([
          [0, 4],
          [0, 4],
        ]),
      ),
    ).toBe(true);
    const split = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [
        [0, 4],
        [4, 8],
      ],
    );
    expect(split.fetches).toEqual(["xorb://0-4", "xorb://4-8"]);
    expect(
      split.out.equals(
        want([
          [0, 4],
          [4, 8],
        ]),
      ),
    ).toBe(true);
  });

  it("each term of a shared fetch is checked when it ends, before the next term's bytes", async () => {
    const shard: Shard = {
      files: [
        {
          fileHash: fileHash(refs),
          terms: [
            {
              xorbHash: xh,
              bytes: bytesOf(0, 4),
              start: 0,
              end: 4,
              rangeHash: rangeHash(refs.slice(0, 4).map((c) => c.hash)),
            },
            {
              xorbHash: xh,
              bytes: bytesOf(4, 8),
              start: 4,
              end: 8,
              rangeHash: rangeHash(refs.slice(4, 8).map((c) => c.hash)),
            },
          ],
        },
      ],
      xorbs: [],
    };
    const termsOnly = () => {
      const v = verifierFromShard(shard, fileHash(refs), { wholeFile: true });
      return { rangeHash: v.rangeHash, done: v.done };
    };
    expect(
      (
        await go(
          [
            [0, 4],
            [4, 8],
          ],
          [[0, 8]],
          { verify: termsOnly() },
        )
      ).error,
    ).toBeUndefined();
    const r = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 8]],
      { verify: termsOnly(), damage: 2 },
    );
    expect(r.error?.message).toMatch(/0-4 does not match/);
    expect(r.out.length).toBe(bytesOf(0, 4)); // nothing of the second term
    const late = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 8]],
      { verify: termsOnly(), damage: 6 },
    );
    expect(late.error?.message).toMatch(/4-8 does not match/);
  });

  it("an offset into the first term and a length ending inside, or exactly at the end of, a later term", async () => {
    const all = want([
      [0, 4],
      [4, 8],
    ]);
    const r = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 8]],
      { offset: 700, length: 1500 },
    );
    expect(r.fetches.length).toBe(1);
    expect(r.out.equals(all.subarray(700, 2200))).toBe(true);
    const exact = await go(
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 8]],
      { length: bytesOf(0, 8) },
    );
    expect(exact.out.equals(all)).toBe(true);
  });
});

describe("H5 portable", () => {
  it("src/ has no node: imports", () => {
    for (const f of readdirSync(join(here, "../src")))
      expect(readFileSync(join(here, "../src", f), "utf8"), f).not.toMatch(/from "node:/);
  });
});
