/**
 * A tiny PNG encoder for sample images: 8-bit RGBA, no compression (zlib
 * "stored" blocks), so the seed needs neither a binary fixture nor a library.
 */
export function createPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Uint8Array {
  const stride = 1 + width * 4;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * stride + 1 + x * 4);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // bit depth 8, RGBA, deflate, filter 0, no interlace

  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

function zlibStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  const max = 0xffff;
  for (let at = 0; at < data.length || at === 0; at += max) {
    const block = data.subarray(at, at + max);
    const last = at + max >= data.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = last;
    new DataView(header.buffer).setUint16(1, block.length, true);
    new DataView(header.buffer).setUint16(3, ~block.length & 0xffff, true);
    parts.push(header, block);
    if (data.length === 0) break;
  }
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, adler32(data));
  parts.push(adler);
  return concat(parts);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat([new TextEncoder().encode(type), data]);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typed, 4);
  view.setUint32(8 + data.length, crc32(typed));
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
