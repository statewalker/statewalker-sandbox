// PNG / JPEG decoding without canvas: every colour type gives the same picture, rows on demand.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeImage, sniff, toRgba } from "../src/decode.ts";

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url);
const have = existsSync(fixture("baiona.png"));

test("sniffs PNG and JPEG", () => {
  assert.equal(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), "png");
  assert.equal(sniff(new Uint8Array([0xff, 0xd8, 0xff])), "jpeg");
  assert.equal(sniff(new Uint8Array([1, 2, 3])), null);
  assert.throws(() => decodeImage(new Uint8Array([1, 2, 3, 4])), /EINVAL/);
});

test("RGB, gray, palette and alpha PNGs decode to the same picture", {
  skip: !have && "run pnpm fixtures",
}, () => {
  const lum = (name) => {
    const { data, width, height } = toRgba(decodeImage(readFileSync(fixture(name))));
    const out = new Float64Array(width * height);
    for (let p = 0; p < out.length; p++) {
      assert.equal(data[p * 4 + 3], 255, "opaque: transparency flattened onto white");
      out[p] = 0.299 * data[p * 4] + 0.587 * data[p * 4 + 1] + 0.114 * data[p * 4 + 2];
    }
    return { out, width, height };
  };
  const rgb = lum("baiona.png");
  for (const name of ["baiona_gray.png", "baiona_colormapped.png", "baiona_alpha.png"]) {
    const other = lum(name);
    assert.deepEqual([other.width, other.height], [rgb.width, rgb.height]);
    let diff = 0;
    for (let p = 0; p < rgb.out.length; p++) diff += Math.abs(rgb.out[p] - other.out[p]);
    assert.ok(
      diff / rgb.out.length < 12,
      `${name}: mean luminance difference ${diff / rgb.out.length}`,
    );
  }
});

test("a 1-bit scan stays compact and hands out rows", {
  skip: !have && "run pnpm fixtures",
}, () => {
  const source = decodeImage(readFileSync(fixture("linn.png")));
  assert.deepEqual([source.width, source.height], [2550, 3300]);
  assert.ok(source.bytes < 1.2e6, `compact: ${source.bytes} bytes`);
  const band = source.rows(1000, 1100);
  assert.equal(band.height, 100);
  assert.equal(band.data.length, 2550 * 100 * 4);
});

test("a JPEG decodes to RGB, rows as RGBA", { skip: !have && "run pnpm fixtures" }, () => {
  const source = decodeImage(readFileSync(fixture("c03-29.jpg")));
  assert.equal(source.bytes, source.width * source.height * 3);
  assert.equal(source.rows(0, 10).data.length, source.width * 10 * 4);
});
