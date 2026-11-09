import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { walkPack } from "../src/pack-walk.js";
import {
  createInflater,
  InflateError,
  inflaterStats,
  inflateSequence,
  TruncatedStreamError,
} from "../src/stream-inflater.js";
import { decompressBlockPartialPako } from "../src/vendor/pako-inflate-vcs.js";

function* chunked(bytes: Uint8Array, size: number): Iterable<Uint8Array> {
  for (let pos = 0; pos < bytes.length; pos += size) yield bytes.subarray(pos, pos + size);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const enc = new TextEncoder();
const CHUNK_SIZES = [1, 2, 7, 64, 4096, Number.MAX_SAFE_INTEGER];

describe("R1 exact stream ends under every chunking", () => {
  const inputs = [
    new Uint8Array(0),
    Uint8Array.of(42),
    enc.encode("the quick brown fox ".repeat(500)),
    new Uint8Array(randomBytes(1 << 20)),
    new Uint8Array(1 << 20),
  ];
  const streams = inputs.map((b) => new Uint8Array(deflateSync(b)));
  const trailing = enc.encode("TRAILING-BYTES");
  const all = concat([...streams, trailing]);

  for (const size of CHUNK_SIZES) {
    it(`chunk size ${size === Number.MAX_SAFE_INTEGER ? "whole" : size}`, async () => {
      const results: Array<{ data: Uint8Array; compressedLength: number }> = [];
      for await (const r of inflateSequence(chunked(all, size), streams.length)) results.push(r);
      expect(results.length).toBe(inputs.length);
      results.forEach((r, i) => {
        expect(r.compressedLength).toBe(streams[i]?.length);
        expect(Buffer.from(r.data).equals(Buffer.from(inputs[i] ?? []))).toBe(true);
      });
      const consumed = results.reduce((n, r) => n + r.compressedLength, 0);
      expect(all.length - consumed).toBe(trailing.length);
    }, 120_000);
  }
});

describe("R2 a real git pack walks end to end", () => {
  let pack: Uint8Array;
  let expected: Array<{ offset: number; type: string; size: number }>;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "x1b-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "a",
          GIT_AUTHOR_EMAIL: "a@x",
          GIT_COMMITTER_NAME: "a",
          GIT_COMMITTER_EMAIL: "a@x",
        },
      });
    git("init", "-q");
    let text = "line\n".repeat(2000);
    for (let v = 0; v < 5; v++) {
      text = text.replace("line\n", `edit ${v}\n`) + `appended ${v}\n`.repeat(50);
      writeFileSync(join(dir, "big.txt"), text);
      writeFileSync(join(dir, `random-${v}.bin`), randomBytes(20_000));
      writeFileSync(join(dir, "empty"), "");
      git("add", "-A");
      git("commit", "-q", "-m", `v${v}`);
    }
    const base = join(dir, "out");
    execFileSync("git", ["-C", dir, "pack-objects", "--revs", "-q", base], { input: "HEAD\n" });
    const name = readdirSync(dir).find((f) => f.startsWith("out-") && f.endsWith(".pack"));
    if (!name) throw new Error("pack not produced");
    pack = new Uint8Array(readFileSync(join(dir, name)));
    expected = execFileSync("git", ["verify-pack", "-v", join(dir, name)])
      .toString()
      .split("\n")
      .filter((l) => /^[0-9a-f]{40} /.test(l))
      .map((l) => {
        const [, type, size, , offset] = l.split(/\s+/);
        return { type: type ?? "", size: Number(size), offset: Number(offset) };
      })
      .sort((a, b) => a.offset - b.offset);
    expect(expected.some((e) => e.type === "blob")).toBe(true);
  });

  for (const size of [1, 4096, Number.MAX_SAFE_INTEGER]) {
    it(`chunk size ${size === Number.MAX_SAFE_INTEGER ? "whole" : size}`, async () => {
      inflaterStats.created = 0;
      const walk = await walkPack(chunked(pack, size));
      expect(walk.version).toBe(2);
      expect(walk.count).toBe(expected.length);
      expect(walk.entries.map((e) => e.offset)).toEqual(expected.map((e) => e.offset));
      for (const e of walk.entries) expect(e.inflatedLength).toBe(e.size);
      expect(walk.trailerOk).toBe(true);
      expect(inflaterStats.created).toBe(expected.length);
      // verify-pack reports ofs-delta entries with the *result* type and size, so compare sizes
      // only for non-delta entries, where both describe the same bytes.
      const nonDelta = walk.entries.filter((e) => e.type < 6);
      expect(nonDelta.length).toBeGreaterThan(0);
      for (const e of nonDelta) {
        expect(e.size).toBe(expected.find((x) => x.offset === e.offset)?.size);
      }
    }, 300_000);
  }
});

describe("R3 truncation is never reported as done", () => {
  const z = new Uint8Array(deflateSync(enc.encode("payload ".repeat(2000))));
  const cuts = [1, 2, Math.floor(z.length / 2), z.length - 4, z.length - 1];
  for (const cut of cuts) {
    it(`cut at ${cut} of ${z.length}`, () => {
      const inf = createInflater();
      let done = false;
      for (const c of chunked(z.subarray(0, cut), 7)) done = inf.push(c).done || done;
      expect(done).toBe(false);
      expect(() => inf.end()).toThrow(TruncatedStreamError);
    });
  }
});

describe("R4 corruption is an error", () => {
  const z = new Uint8Array(deflateSync(enc.encode("payload ".repeat(2000))));
  it("flipped byte in the Adler-32 trailer", () => {
    const bad = z.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
    const inf = createInflater();
    expect(() => {
      for (const c of chunked(bad, 64)) inf.push(c);
      inf.end();
    }).toThrow(InflateError);
  });
  it("garbage body", () => {
    const bad = concat([z.subarray(0, 2), new Uint8Array(randomBytes(200)).fill(0xff, 0, 4)]);
    const inf = createInflater();
    expect(() => {
      for (const c of chunked(bad, 64)) inf.push(c);
      inf.end();
    }).toThrow(InflateError);
  });
});

describe("R5 traps, documented as passing tests", () => {
  const data = enc.encode("hello world ".repeat(1000));
  const z = new Uint8Array(deflateSync(data));
  it("(a) webrun-vcs decompressBlockPartialPako returns short data, no error, on truncated input", () => {
    const r = decompressBlockPartialPako(z.subarray(0, Math.floor(z.length / 2)));
    expect(r.data.length).toBeLessThan(data.length);
  });
  it("(b) DecompressionStream rejects trailing bytes and has no consumed count", async () => {
    const withTrailing = concat([z, Uint8Array.of(1, 2, 3)]);
    const s = new Blob([withTrailing as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
    await expect(new Response(s).arrayBuffer()).rejects.toThrow(/Trailing junk/);
    expect("bytesRead" in new DecompressionStream("deflate")).toBe(false);
  });
  it("(c) Node 22 zlib.inflateSync silently ignores trailing bytes (no position reported)", () => {
    const out = inflateSync(concat([z, Uint8Array.of(1, 2, 3)]));
    expect(out.length).toBe(data.length);
  });
});

describe("R5 (d) trap found while going green: output views must not pin the output buffer", () => {
  it("4 KiB of incompressible output pushed 1 byte at a time keeps arrayBuffers growth small", () => {
    const input = new Uint8Array(randomBytes(4096));
    const z = new Uint8Array(deflateSync(input));
    const base = process.memoryUsage().arrayBuffers;
    const kept: Uint8Array[] = [];
    const inf = createInflater();
    for (const c of chunked(z, 1)) kept.push(...inf.push(c).out);
    inf.end();
    // With per-push 64 KiB buffers returned as views, ~4096 views pin ~256 MiB.
    expect(process.memoryUsage().arrayBuffers - base).toBeLessThan(32 * 1024 * 1024);
    expect(kept.reduce((n, k) => n + k.length, 0)).toBe(input.length);
  });
});
