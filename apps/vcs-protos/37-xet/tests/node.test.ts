import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
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
    const before = process.memoryUsage();
    let peak = 0;
    const got: ChunkRef[] = [];
    let size = 0;
    for await (const chunk of chunkStream(reconstruct(answer, fetchRange))) {
      got.push({ hash: chunkHash(chunk), length: chunk.length });
      size += chunk.length;
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers - before.heapUsed - before.arrayBuffers);
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
    // the file is 63 MB; streaming keeps a few chunks and fetched pieces, not the file
    expect(peak).toBeLessThan(40 * 1024 * 1024);
  }, 300_000);
});

describe("H5 portable", () => {
  it("src/ has no node: imports", () => {
    for (const f of readdirSync(join(here, "../src")))
      expect(readFileSync(join(here, "../src", f), "utf8"), f).not.toMatch(/from "node:/);
  });
});
