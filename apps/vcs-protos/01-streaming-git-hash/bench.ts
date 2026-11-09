import { randomBytes } from "node:crypto";
import { hashGitObject, type Sha1Impl } from "./src/git-object-hash.js";

const IMPLS: Sha1Impl[] = ["vcs", "noble", "node"];

export async function bench01(): Promise<string> {
  const CHUNK = 64 * 1024;
  const TOTAL = 256 * 1024 * 1024;
  const buf = new Uint8Array(randomBytes(CHUNK));
  async function* big(): AsyncIterable<Uint8Array> {
    for (let off = 0; off < TOTAL; off += CHUNK) yield buf;
  }
  const small = Array.from({ length: 20_000 }, () => new Uint8Array(randomBytes(200)));
  const rows: string[] = [
    "| impl | 256 MiB stream (MB/s) | 20k × 200 B objects (objects/s) |",
    "|---|---|---|",
  ];
  for (const impl of IMPLS) {
    await hashGitObject("blob", 1024, [new Uint8Array(1024)], impl); // warm-up
    let t = performance.now();
    await hashGitObject("blob", TOTAL, big(), impl);
    const mbps = TOTAL / 1e6 / ((performance.now() - t) / 1000);
    t = performance.now();
    for (const o of small) await hashGitObject("blob", o.length, [o], impl);
    const ops = small.length / ((performance.now() - t) / 1000);
    rows.push(`| ${impl} | ${mbps.toFixed(0)} | ${ops.toFixed(0)} |`);
  }
  return rows.join("\n");
}
