/**
 * Node-only: hand-built packs for edge cases git never writes (REF on REF, forward refs, cycles,
 * duplicates, counts, bombs, deep chains). Adapted from the X6a review's experiments.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export interface CraftEntry {
  kind: number; // 1-4, 6 OFS_DELTA, 7 REF_DELTA
  data: Uint8Array; // object content, or delta data
  baseOid?: string; // REF_DELTA
  baseIdx?: number; // OFS_DELTA: index of an earlier entry
  back?: number; // OFS_DELTA: explicit back-offset (to point anywhere)
  rawZ?: Uint8Array; // explicit zlib bytes
  sizeOverride?: number; // header size different from data.length
}
export const oidOf = (type: string, d: Uint8Array) =>
  createHash("sha1").update(`${type} ${d.length}\0`).update(d).digest("hex");
export const varint = (n: number) => {
  const o: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    o.push(b);
  } while (n);
  return o;
};
export const delta = (baseLen: number, resultLen: number, ops: number[]) =>
  Uint8Array.from([...varint(baseLen), ...varint(resultLen), ...ops]);
/** copy [0, n) of the base (n ≤ 0xffffff) */
export const copyAll = (n: number) => [
  0x80 | 0x10 | 0x20 | 0x40,
  n & 255,
  (n >> 8) & 255,
  (n >> 16) & 255,
];

export function buildPack(
  entries: CraftEntry[],
  opts: { count?: number; version?: number } = {},
): Uint8Array {
  const parts: number[] = [];
  const head = Buffer.alloc(12);
  head.write("PACK");
  head.writeUInt32BE(opts.version ?? 2, 4);
  head.writeUInt32BE(opts.count ?? entries.length, 8);
  parts.push(...head);
  const offsets: number[] = [];
  for (const e of entries) {
    const off = parts.length;
    offsets.push(off);
    let size = e.sizeOverride ?? e.data.length;
    let b = (e.kind << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size) {
      parts.push(b | 0x80);
      b = size & 127;
      size = Math.floor(size / 128);
    }
    parts.push(b);
    if (e.kind === 6) {
      let back = e.back ?? off - (offsets[e.baseIdx as number] as number);
      const bs = [back & 127];
      back = Math.floor(back / 128);
      while (back) {
        back--;
        bs.unshift(0x80 | (back & 127));
        back = Math.floor(back / 128);
      }
      parts.push(...bs);
    }
    if (e.kind === 7) parts.push(...Buffer.from(e.baseOid as string, "hex"));
    const z = e.rawZ ?? deflateSync(e.data);
    for (const x of z) parts.push(x);
  }
  const body = Buffer.from(parts);
  return new Uint8Array(Buffer.concat([body, createHash("sha1").update(body).digest()]));
}
