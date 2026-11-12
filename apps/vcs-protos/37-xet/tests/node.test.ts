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
  rangeHash,
  reconstruct,
  writeXorb,
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
    // LZ4's end-of-block rules, which decoders may rely on (ours does not check them): the last
    // 5 bytes are literals, and no match starts within the last 12
    for (const [name, data] of cases) {
      const block = lz4BlockEncode(data);
      let at = 0;
      let o = 0;
      while (at < block.length) {
        const token = block[at++] as number;
        let lit = token >> 4;
        if (lit === 15) for (let b = 255; b === 255; lit += b) b = block[at++] as number;
        at += lit;
        o += lit;
        if (at >= block.length) break;
        at += 2;
        let len = (token & 15) + 4;
        if ((token & 15) === 15) for (let b = 255; b === 255; len += b) b = block[at++] as number;
        expect(o, `${name}: a match starts within the last 12 bytes`).toBeLessThanOrEqual(
          data.length - 12,
        );
        o += len;
        expect(o, `${name}: a match covers the last 5 bytes`).toBeLessThanOrEqual(data.length - 5);
      }
      expect(o, name).toBe(data.length);
    }
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

describe("H5 portable", () => {
  it("src/ has no node: imports", () => {
    for (const f of readdirSync(join(here, "../src")))
      expect(readFileSync(join(here, "../src", f), "utf8"), f).not.toMatch(/from "node:/);
  });
});
