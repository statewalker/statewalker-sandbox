import { deflateSync, inflateSync } from "node:zlib";
import { createInflaterPool, createUnpooledInflater } from "./src/pooled-inflater.js";

const ROUNDS = 7; // ratios: median of per-round ratios (min–max), order rotated per round
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

export async function bench04(): Promise<string> {
  const enc = new TextEncoder();
  const sets: Array<[string, Uint8Array[]]> = [
    [
      "20k × ~240 B (tree/commit-sized)",
      Array.from(
        { length: 20_000 },
        (_, i) => new Uint8Array(deflateSync(enc.encode(`tree entry ${i} `.repeat(15)))),
      ),
    ],
    [
      "5k × ~8 KiB (small source files)",
      Array.from(
        { length: 5_000 },
        (_, i) =>
          new Uint8Array(deflateSync(enc.encode(`line ${i} of a small source file\n`.repeat(250)))),
      ),
    ],
  ];
  const rows = [
    `| objects | unpooled (objects/s) | pooled (objects/s) | node:zlib inflateSync (objects/s) | pooled ÷ unpooled | pooled ÷ inflateSync |`,
    "|---|---|---|---|---|---|",
  ];
  for (const [name, objs] of sets) {
    const rate = (fn: () => void) => {
      const t = performance.now();
      fn();
      return objs.length / ((performance.now() - t) / 1000);
    };
    const pool = createInflaterPool();
    const unpooled = () =>
      rate(() => {
        for (const z of objs) {
          const inf = createUnpooledInflater();
          inf.push(z);
          inf.end();
        }
      });
    const pooled = () =>
      rate(() => {
        for (const z of objs) {
          const inf = pool.acquire();
          inf.push(z);
          inf.end();
        }
      });
    const native = () =>
      rate(() => {
        for (const z of objs) inflateSync(z);
      });
    const gc = (globalThis as { gc?: () => void }).gc;
    // Each timed run starts after a forced GC (when available), and the order rotates per
    // round, so one variant's garbage is not billed to the next (review of #50).
    const timed = (fn: () => number) => {
      gc?.();
      return fn();
    };
    unpooled();
    pooled();
    native(); // warm-up
    const u: number[] = [];
    const p: number[] = [];
    const n: number[] = [];
    const vsUnpooled: number[] = [];
    const vsNative: number[] = [];
    const variants = [unpooled, pooled, native];
    for (let r = 0; r < ROUNDS; r++) {
      const got = new Map<() => number, number>();
      for (let k = 0; k < variants.length; k++) {
        const v = variants[(r + k) % variants.length] as () => number;
        got.set(v, timed(v));
      }
      const a = got.get(unpooled) ?? 0;
      const b = got.get(pooled) ?? 0;
      const c = got.get(native) ?? 0;
      u.push(a);
      p.push(b);
      n.push(c);
      vsUnpooled.push(b / a);
      vsNative.push(b / c);
    }
    const f = (x: number) => x.toFixed(2);
    const span = (xs: number[]) =>
      `${f(median(xs))}× (${f(Math.min(...xs))}–${f(Math.max(...xs))})`;
    rows.push(
      `| ${name} | ${median(u).toFixed(0)} | ${median(p).toFixed(0)} | ${median(n).toFixed(0)} | ${span(vsUnpooled)} | ${span(vsNative)} |`,
    );
  }
  return rows.join("\n");
}
