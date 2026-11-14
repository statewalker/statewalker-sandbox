/** X6a vs X6b1 on the same packs: peak live memory and time.  node --expose-gc --import tsx 14-thin-packs/scripts/compare.ts */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import {
  buildPack,
  type CraftEntry,
  copyAll,
  delta,
  oidOf,
} from "../../12-index-pack/src/craft.js";
import { packAll, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { installPack as x6a } from "../../12-index-pack/src/index-pack.js";
import { installPack as x6b } from "../src/index-pack.js";

const gc = () => (globalThis as { gc?: () => void }).gc?.();
const live = () => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
function bigPack(n: number) {
  const enc = new TextEncoder();
  const entries: CraftEntry[] = [];
  for (let i = 0; i < n; i++) {
    const k = i % 4;
    if (k === 1 || k === 3) {
      const prev = enc.encode(`blob number ${i - 1} ${"x".repeat(20)}`);
      const tail = enc.encode(`+${i}`);
      const d = delta(prev.length, prev.length + tail.length, [
        ...copyAll(prev.length),
        tail.length,
        ...tail,
      ]);
      entries.push(
        k === 1
          ? { kind: 7, baseOid: oidOf("blob", prev), data: d }
          : { kind: 6, baseIdx: i - 1, data: d },
      );
    } else entries.push({ kind: 3, data: enc.encode(`blob number ${i} ${"x".repeat(20)}`) });
  }
  return buildPack(entries);
}
async function run(name: string, install: typeof x6b, pack: Uint8Array) {
  const d = mkdtempSync(join(tmpdir(), "cmp-"));
  const files = new StreamingNodeFilesApi(d);
  const read = files.read.bind(files);
  let peak = 0;
  let n = 0;
  gc();
  const base = live();
  files.read = (p, o) =>
    (async function* () {
      for await (const c of read(p, o)) {
        if (++n % 64 === 1) {
          gc();
          peak = Math.max(peak, live() - base);
        }
        yield c;
      }
    })();
  const t0 = performance.now();
  await install(
    files,
    "/objects/pack",
    (async function* () {
      yield pack;
    })(),
  );
  const ms = performance.now() - t0;
  console.log(
    `${name}: ${ms.toFixed(0)} ms (sampled: GC every 64th chunk read), peak +${(peak / 2 ** 20).toFixed(1)} MiB`,
  );
  rmSync(d, { recursive: true, force: true });
}
const big = bigPack(200_000);
const hist = packAll(repoWithHistory(60), true);
for (const [n, p] of [
  ["200k objects", big],
  ["history (60 commits)", hist],
] as const) {
  await run(`X6a  ${n}`, x6a as typeof x6b, p);
  await run(`X6b1 ${n}`, x6b, p);
}
// unsampled timings
for (const [n, p] of [
  ["200k objects", big],
  ["history (60 commits)", hist],
] as const) {
  for (const [name, f] of [
    ["X6a ", x6a],
    ["X6b1", x6b],
  ] as const) {
    const d = mkdtempSync(join(tmpdir(), "cmp-"));
    const t0 = performance.now();
    await (f as typeof x6b)(
      new StreamingNodeFilesApi(d),
      "/objects/pack",
      (async function* () {
        yield p;
      })(),
    );
    console.log(`${name} ${n}: ${(performance.now() - t0).toFixed(0)} ms unsampled`);
    rmSync(d, { recursive: true, force: true });
  }
}
