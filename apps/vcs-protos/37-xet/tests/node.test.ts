import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GEAR_TABLE } from "../src/gear-table.js";
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
  xorbHash,
} from "../src/xet.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "../fixtures", name), "utf8");
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

/** the reference xorb, downloaded once from the specification's dataset into the temp directory */
function referenceXorb(): string {
  const path = join(tmpdir(), `x11-${XORB}.xorb`);
  if (!existsSync(path) || statSync(path).size !== 14_737_817)
    execFileSync("curl", [
      "-sSfL",
      "--retry",
      "3",
      "-o",
      path,
      `https://huggingface.co/datasets/xet-team/xet-spec-reference-files/resolve/main/${XORB}.xorb`,
    ]);
  expect(statSync(path).size).toBe(14_737_817);
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

describe("H7 chunk boundaries at the minimum size, against the specification's own steps", () => {
  /** the specification's chunker, literally: every byte hashed (BigInt), the mask tested from 8 KiB */
  function specChunkLengths(data: Uint8Array): number[] {
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
      expect(ours, `window ending at ${end}`).toEqual(specChunkLengths(data));
    }
  }, 120_000);
});

describe("H5 portable", () => {
  it("src/ has no node: imports", () => {
    for (const f of readdirSync(join(here, "../src")))
      expect(readFileSync(join(here, "../src", f), "utf8"), f).not.toMatch(/from "node:/);
  });
});
