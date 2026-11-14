import { createHash, randomBytes } from "node:crypto";
import { createBlake3, createSha256, type Hasher } from "./src/hashes.js";

export async function bench03(): Promise<string> {
  const CHUNK = 64 * 1024;
  const TOTAL = 256 * 1024 * 1024;
  const buf = new Uint8Array(randomBytes(CHUNK));
  const key = new Uint8Array(32).fill(7);
  const wrapNode = (h: ReturnType<typeof createHash>): Hasher => {
    const self: Hasher = {
      update(b) {
        h.update(b);
        return self;
      },
      digest: () => new Uint8Array(h.digest()),
      clone: () => wrapNode(h.copy()),
    };
    return self;
  };
  const nodeSha256 = () => wrapNode(createHash("sha256"));
  const cases: Array<[string, () => Hasher]> = [
    ["SHA-256 noble", createSha256],
    ["SHA-256 node:crypto", nodeSha256],
    ["BLAKE3 noble", () => createBlake3()],
    ["BLAKE3 noble keyed", () => createBlake3({ key })],
  ];
  const rows = ["| hash | 256 MiB stream (MB/s) |", "|---|---|"];
  for (const [name, make] of cases) {
    make().update(buf).digest(); // warm-up
    const t = performance.now();
    const h = make();
    for (let off = 0; off < TOTAL; off += CHUNK) h.update(buf);
    h.digest();
    rows.push(`| ${name} | ${(TOTAL / 1e6 / ((performance.now() - t) / 1000)).toFixed(0)} |`);
  }
  return rows.join("\n");
}
