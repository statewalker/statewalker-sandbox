import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createPng } from "../src/png";

function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: Uint8Array; crc: number }[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    out.push({
      type,
      data: png.subarray(at + 8, at + 8 + length),
      crc: view.getUint32(at + 8 + length),
    });
    at += 12 + length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

describe("createPng", () => {
  const png = createPng(3, 2, (x, y) => [x * 100, y * 200, 50, 255]);
  const parts = chunks(png);

  it("has the PNG signature and IHDR, IDAT, IEND chunks", () => {
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(parts.map((p) => p.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("declares the size, 8-bit RGBA", () => {
    const ihdr = new DataView(parts[0].data.buffer, parts[0].data.byteOffset);
    expect(ihdr.getUint32(0)).toBe(3);
    expect(ihdr.getUint32(4)).toBe(2);
    expect(parts[0].data[8]).toBe(8); // bit depth
    expect(parts[0].data[9]).toBe(6); // colour type RGBA
  });

  it("has a valid CRC on every chunk", () => {
    for (const part of parts) {
      const typed = new Uint8Array(4 + part.data.length);
      typed.set(new TextEncoder().encode(part.type));
      typed.set(part.data, 4);
      expect(part.crc).toBe(crc32(typed));
    }
  });

  it("stores the pixels as a valid zlib stream of filtered scanlines", () => {
    const raw = inflateSync(parts[1].data);
    expect(raw.length).toBe(2 * (1 + 3 * 4));
    expect(Array.from(raw.subarray(0, 5))).toEqual([0, 0, 0, 50, 255]); // filter 0, pixel (0,0)
    expect(Array.from(raw.subarray(13 + 1 + 8, 13 + 1 + 12))).toEqual([200, 200, 50, 255]); // (2,1)
  });
});
