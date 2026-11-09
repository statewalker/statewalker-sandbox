import { deflateSync, inflateSync } from "node:zlib";
import { createInflaterPool, createUnpooledInflater } from "./src/pooled-inflater.js";

const ROUNDS = 7;
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
    `| objects | unpooled (objects/s) | pooled (objects/s) | node:zlib (objects/s) | pooled ÷ unpooled, median of ${ROUNDS} paired rounds (min–max) |`,
    "|---|---|---|---|---|",
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
    unpooled();
    pooled();
    native(); // warm-up
    const u: number[] = [];
    const p: number[] = [];
    const n: number[] = [];
    const ratio: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      const a = unpooled();
      const b = pooled();
      u.push(a);
      p.push(b);
      n.push(native());
      ratio.push(b / a);
    }
    const f = (x: number) => x.toFixed(2);
    rows.push(
      `| ${name} | ${median(u).toFixed(0)} | ${median(p).toFixed(0)} | ${median(n).toFixed(0)} | ${f(median(ratio))}× (${f(Math.min(...ratio))}–${f(Math.max(...ratio))}) |`,
    );
  }
  return rows.join("\n");
}
