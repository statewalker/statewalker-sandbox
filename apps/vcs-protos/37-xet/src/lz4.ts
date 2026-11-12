/**
 * X11 — an LZ4 frame decoder (the LZ4 Frame Format 1.6.x), enough for Xet chunks: one frame, linked
 * or independent blocks, optional content size, block and content checksums skipped (each Xet
 * chunk is verified by its BLAKE3 hash instead). No dictionary support.
 */

const MAGIC = 0x184d2204;

function readU32(b: Uint8Array, at: number): number {
  return (
    ((b[at] as number) |
      ((b[at + 1] as number) << 8) |
      ((b[at + 2] as number) << 16) |
      ((b[at + 3] as number) << 24)) >>>
    0
  );
}

/** decodes one LZ4 frame whose content is `size` bytes */
export function lz4FrameDecode(src: Uint8Array, size: number): Uint8Array {
  if (readU32(src, 0) !== MAGIC) throw new Error("lz4: not a frame");
  const flg = src[4] as number;
  if (flg >> 6 !== 1) throw new Error("lz4: unsupported frame version");
  const blockChecksum = (flg & 0x10) !== 0;
  const contentSize = (flg & 0x08) !== 0;
  if (flg & 0x01) throw new Error("lz4: dictionaries are not supported");
  let at = 6 + (contentSize ? 8 : 0) + 1; // FLG BD [content size] HC
  const out = new Uint8Array(size);
  let o = 0;
  for (;;) {
    const word = readU32(src, at);
    at += 4;
    if (word === 0) break; // end mark (a content checksum may follow)
    const n = word & 0x7fffffff;
    if (word & 0x80000000) {
      out.set(src.subarray(at, at + n), o);
      o += n;
    } else o = decodeBlock(src, at, at + n, out, o);
    at += n + (blockChecksum ? 4 : 0);
  }
  if (o !== size) throw new Error(`lz4: frame has ${o} bytes, expected ${size}`);
  return out;
}

/** one LZ4 block into `out` from `o` (earlier output is the window of linked blocks) */
function decodeBlock(src: Uint8Array, at: number, end: number, out: Uint8Array, o: number): number {
  while (at < end) {
    const token = src[at++] as number;
    let lit = token >> 4;
    if (lit === 15) {
      let b: number;
      do {
        b = src[at++] as number;
        lit += b;
      } while (b === 255);
    }
    out.set(src.subarray(at, at + lit), o);
    at += lit;
    o += lit;
    if (at >= end) break; // the last sequence has literals only
    const offset = (src[at] as number) | ((src[at + 1] as number) << 8);
    at += 2;
    if (offset === 0 || offset > o) throw new Error("lz4: bad match offset");
    let len = (token & 15) + 4;
    if ((token & 15) === 15) {
      let b: number;
      do {
        b = src[at++] as number;
        len += b;
      } while (b === 255);
    }
    if (o + len > out.length) throw new Error("lz4: output overflow");
    // overlapping copies repeat the last `offset` bytes: copy byte by byte when they overlap
    if (offset >= len) out.copyWithin(o, o - offset, o - offset + len);
    else for (let i = 0; i < len; i++) out[o + i] = out[o - offset + i] as number;
    o += len;
  }
  return o;
}
