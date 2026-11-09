import { randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { createInflater } from "./src/stream-inflater.js";

function* chunked(bytes: Uint8Array, size: number): Iterable<Uint8Array> {
  for (let pos = 0; pos < bytes.length; pos += size) yield bytes.subarray(pos, pos + size);
}

export async function bench02(): Promise<string> {
  const MiB = 1 << 20;
  const text = new TextEncoder().encode(
    Array.from({ length: 400_000 }, (_, i) => `line ${i} of some source file content\n`).join(""),
  );
  const cases: Array<[string, Uint8Array]> = [
    [`text ${(text.length / MiB).toFixed(0)} MiB`, text],
    ["random 16 MiB", new Uint8Array(randomBytes(16 * MiB))],
  ];
  const small = Array.from(
    { length: 20_000 },
    (_, i) => new Uint8Array(deflateSync(new TextEncoder().encode(`tree entry ${i} `.repeat(15)))),
  );
  const rows = [
    "| input | pako push, 64 KiB chunks (MB/s out) | node:zlib inflateSync (MB/s out) |",
    "|---|---|---|",
  ];
  for (const [name, data] of cases) {
    const z = new Uint8Array(deflateSync(data));
    let t = performance.now();
    const inf = createInflater();
    let n = 0;
    for (const c of chunked(z, 64 * 1024)) for (const o of inf.push(c).out) n += o.length;
    inf.end();
    const pako = n / 1e6 / ((performance.now() - t) / 1000);
    t = performance.now();
    const m = inflateSync(z).length;
    const node = m / 1e6 / ((performance.now() - t) / 1000);
    rows.push(`| ${name} | ${pako.toFixed(0)} | ${node.toFixed(0)} |`);
  }
  let t = performance.now();
  for (const z of small) {
    const inf = createInflater();
    inf.push(z);
    inf.end();
  }
  const pakoOps = small.length / ((performance.now() - t) / 1000);
  t = performance.now();
  for (const z of small) inflateSync(z);
  const nodeOps = small.length / ((performance.now() - t) / 1000);
  rows.push(`| 20k small objects (objects/s) | ${pakoOps.toFixed(0)} | ${nodeOps.toFixed(0)} |`);
  return rows.join("\n");
}
