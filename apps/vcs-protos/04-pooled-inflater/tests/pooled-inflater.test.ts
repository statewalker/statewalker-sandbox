import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  createInflaterPool,
  InflateError,
  type InflaterPool,
  type StreamInflater,
  TruncatedStreamError,
} from "../src/pooled-inflater.js";

const enc = new TextEncoder();
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
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** Inflate `count` streams from chunks through a pool; returns outputs and compressed lengths. */
function inflateAll(pool: InflaterPool, chunks: Iterable<Uint8Array>, count: number) {
  const results: Array<{ data: Uint8Array; compressedLength: number }> = [];
  let inf: StreamInflater | undefined;
  let out: Uint8Array[] = [];
  let consumed = 0;
  for (let chunk of chunks) {
    while (chunk.length > 0 && results.length < count) {
      inf ??= pool.acquire();
      const r = inf.push(chunk);
      out.push(...r.out);
      consumed += r.consumed;
      chunk = chunk.subarray(r.consumed);
      if (r.done) {
        inf.end();
        results.push({ data: concat(out), compressedLength: consumed });
        inf = undefined;
        out = [];
        consumed = 0;
      }
    }
  }
  return results;
}

const inputs = Array.from({ length: 200 }, (_, i) => {
  const size = [0, 1, 37, 200, 1000, 4096, 65536][i % 7] ?? 0;
  return i % 3 === 0 ? new Uint8Array(randomBytes(size)) : enc.encode("x".repeat(size));
});
const streams = inputs.map((b) => new Uint8Array(deflateSync(b)));
const all = concat([...streams, enc.encode("TRAILING")]);

describe("R1 exact ends across 200 pooled streams", () => {
  for (const size of [1, 7, 4096, Number.MAX_SAFE_INTEGER]) {
    it(`chunk size ${size === Number.MAX_SAFE_INTEGER ? "whole" : size}`, () => {
      const results = inflateAll(createInflaterPool(), chunked(all, size), streams.length);
      expect(results.length).toBe(streams.length);
      results.forEach((r, i) => {
        expect(r.compressedLength).toBe(streams[i]?.length);
        expect(eq(r.data, inputs[i] ?? new Uint8Array())).toBe(true);
      });
    }, 120_000);
  }
});

describe("R2 one ZStream per pool for sequential use", () => {
  it("200 streams, 1 allocation", () => {
    const pool = createInflaterPool();
    inflateAll(pool, [all], streams.length);
    expect(pool.allocated).toBe(1);
  });
});

describe("R2b the pool retains at most 4 idle states (JGit InflaterCache SZ = 4)", () => {
  it("6 released at once, then 6 acquired: only 4 come from the pool", () => {
    const pool = createInflaterPool();
    const six = Array.from({ length: 6 }, () => pool.acquire());
    for (const inf of six) {
      inf.push(streams[1] ?? new Uint8Array());
      inf.end();
    }
    expect(pool.allocated).toBe(6);
    expect(pool.idle).toBe(4);
    for (let i = 0; i < 6; i++) pool.acquire();
    expect(pool.allocated).toBe(8);
  });
});

describe("R3 state is clean, and reused, after a failed stream", () => {
  const good = streams[4] ?? new Uint8Array();
  const goodInput = inputs[4] ?? new Uint8Array();
  it("after truncation", () => {
    const pool = createInflaterPool();
    const a = pool.acquire();
    a.push(good.subarray(0, Math.floor(good.length / 2)));
    expect(() => a.end()).toThrow(TruncatedStreamError);
    const [r] = inflateAll(pool, [good], 1);
    expect(r && eq(r.data, goodInput)).toBe(true);
    expect(r?.compressedLength).toBe(good.length);
    // The failed state was reset and reused, not leaked and replaced.
    expect(pool.allocated).toBe(1);
  });
  it("after corruption of the header and of the body (not only the trailer)", () => {
    for (const at of [0, Math.floor(good.length / 2)]) {
      const pool = createInflaterPool();
      const bad = good.slice();
      bad[at] = (bad[at] ?? 0) ^ 0xff;
      if (at > 0) bad.fill(0xff, at, at + 8); // an invalid block mid-stream
      const a = pool.acquire();
      // A corrupted header is an InflateError. A corrupted body may instead decode as garbage
      // that never reaches a stream end, so end() reports truncation. Both are rejections;
      // the point is that the state comes back clean either way.
      let err: unknown;
      try {
        a.push(bad);
        a.end();
      } catch (e) {
        err = e;
      }
      expect(err instanceof InflateError || err instanceof TruncatedStreamError).toBe(true);
      if (at === 0) expect(err).toBeInstanceOf(InflateError);
      const [r] = inflateAll(pool, [good], 1);
      expect(r && eq(r.data, goodInput)).toBe(true);
      expect(pool.allocated).toBe(1);
    }
  });
  it("after corruption", () => {
    const pool = createInflaterPool();
    const bad = good.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
    const a = pool.acquire();
    expect(() => {
      a.push(bad);
      a.end();
    }).toThrow(InflateError);
    const [r] = inflateAll(pool, [good], 1);
    expect(r && eq(r.data, goodInput)).toBe(true);
    expect(pool.allocated).toBe(1);
  });
});

describe("R4 concurrent inflaters get distinct state", () => {
  it("interleaved pushes", () => {
    const pool = createInflaterPool();
    const [s1, s2] = [streams[5] ?? new Uint8Array(), streams[6] ?? new Uint8Array()];
    const a = pool.acquire();
    const b = pool.acquire();
    const outA: Uint8Array[] = [];
    const outB: Uint8Array[] = [];
    const ca = [...chunked(s1, 3)];
    const cb = [...chunked(s2, 3)];
    for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
      const x = ca[i];
      const y = cb[i];
      if (x) outA.push(...a.push(x).out);
      if (y) outB.push(...b.push(y).out);
    }
    a.end();
    b.end();
    expect(eq(concat(outA), inputs[5] ?? new Uint8Array())).toBe(true);
    expect(eq(concat(outB), inputs[6] ?? new Uint8Array())).toBe(true);
    expect(pool.allocated).toBe(2);
  });
});

describe("R5 no use after release", () => {
  it("push after end throws", () => {
    const pool = createInflaterPool();
    const a = pool.acquire();
    a.push(streams[1] ?? new Uint8Array());
    a.end();
    expect(() => a.push(Uint8Array.of(1))).toThrow(/returned to the pool/);
  });
  it("a stale handle cannot disturb the inflater that now owns its state", () => {
    const pool = createInflaterPool();
    const a = pool.acquire();
    a.push(streams[1] ?? new Uint8Array());
    a.end();
    const b = pool.acquire(); // reuses a's state
    expect(pool.allocated).toBe(1);
    const s = streams[4] ?? new Uint8Array();
    const out: Uint8Array[] = [];
    const parts = [...chunked(s, 5)];
    out.push(...b.push(parts[0] ?? new Uint8Array()).out);
    expect(() => a.push(Uint8Array.of(0x78, 0x9c))).toThrow(/returned to the pool/);
    for (const p of parts.slice(1)) out.push(...b.push(p).out);
    b.end();
    expect(eq(concat(out), inputs[4] ?? new Uint8Array())).toBe(true);
  });
});

describe("R7 an idle pooled state does not keep the caller's input alive", () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  it("the last input chunk is collectable after its stream ends", async () => {
    expect(gc).toBeTypeOf("function");
    const pool = createInflaterPool();
    const ref = (() => {
      const big = concat([streams[4] ?? new Uint8Array(), new Uint8Array(4 << 20)]);
      const inf = pool.acquire();
      inf.push(big); // stream ends inside `big`; the tail is trailing data
      inf.end();
      return new WeakRef(big);
    })();
    expect(pool.idle).toBe(1);
    for (let i = 0; i < 5 && ref.deref(); i++) {
      await new Promise((r) => setTimeout(r, 10));
      gc?.();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

describe("R8 portable modules import nothing from node:", () => {
  it("src/ is free of node: imports", () => {
    const srcDir = join(import.meta.dirname, "../src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("pooled-inflater.ts");
    for (const f of files) {
      expect(readFileSync(join(srcDir, f), "utf8"), f).not.toMatch(/from\s+["']node:/);
    }
  });
});
