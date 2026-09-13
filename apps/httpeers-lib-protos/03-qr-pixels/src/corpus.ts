/**
 * The corpus: one real join blob, rendered as a QR code and then degraded the
 * ways a camera degrades one.
 *
 * WHY SYNTHETIC, AND WHAT THAT COSTS. `src/browser/qr-decode.ts` records that
 * jsqr was dropped because it "failed on real photos" — photographs taken with
 * a phone, off a screen. No such photograph survives in the repository, so
 * this rung MANUFACTURES the degradations instead: blur, rotation, perspective,
 * JPEG artefacts, low contrast, glare, and small capture sizes. That is weaker
 * evidence than a real photo and is labelled as such everywhere it is used.
 * `HTTPEERS_QR_PHOTOS=<dir>` adds real photographs to the same run, and the
 * test reports them separately — the honest version of this rung is one
 * somebody points at a folder of phone photos.
 *
 * Each case is a named, reproducible transform, so a decoder's score can be
 * read per degradation rather than as one number.
 */

import { qrModules } from "@statewalker/httpeers-stack/src/browser/qr-encode.js";
import sharp from "sharp";

/** Modules of quiet zone, matching `qr-encode.ts`'s own. */
const QUIET_ZONE = 4;

export interface GrayImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Case {
  name: string;
  /** What real-world condition this stands in for. */
  stands_for: string;
  png: Buffer;
}

/** The QR as a clean 1-bit-per-module raster, `scale` device pixels per module. */
export async function renderQrPng(text: string, scale: number): Promise<Buffer> {
  const modules = qrModules(text);
  const n = modules.length;
  const size = (n + QUIET_ZONE * 2) * scale;
  const raw = Buffer.alloc(size * size, 255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules[y]?.[x] !== true) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = (y + QUIET_ZONE) * scale + dy;
        const start = row * size + (x + QUIET_ZONE) * scale;
        raw.fill(0, start, start + scale);
      }
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 1 } })
    .png()
    .toBuffer();
}

/**
 * Build the degraded corpus from one payload.
 *
 * The base render is 8 device pixels per module — a 45×45 code at ~420 px,
 * about what a code fills on a phone screen photographed from a comfortable
 * distance.
 */
export async function buildCorpus(text: string): Promise<Case[]> {
  const base = await renderQrPng(text, 8);
  const cases: Case[] = [{ name: "pristine", stands_for: "a screenshot", png: base }];

  const add = async (name: string, stands_for: string, png: Promise<Buffer>): Promise<void> => {
    cases.push({ name, stands_for, png: await png });
  };

  await add(
    "blur-1.5",
    "a slightly out-of-focus phone camera",
    sharp(base).blur(1.5).png().toBuffer(),
  );
  await add("blur-3", "a badly out-of-focus camera", sharp(base).blur(3).png().toBuffer());
  await add(
    "rotate-7",
    "a phone held at a slight angle",
    sharp(base).rotate(7, { background: "#fff" }).png().toBuffer(),
  );
  await add(
    "rotate-20",
    "a phone held carelessly",
    sharp(base).rotate(20, { background: "#fff" }).png().toBuffer(),
  );
  await add(
    "perspective",
    "photographed off-axis, so the square is a trapezium",
    sharp(base).affine([1, 0.18, 0.08, 1], { background: "#fff" }).png().toBuffer(),
  );
  await add(
    "jpeg-40",
    "a photo saved by a camera app, with ringing around the modules",
    sharp(base).jpeg({ quality: 40 }).toBuffer(),
  );
  await add(
    "low-contrast",
    "a dim screen, or a photo in poor light",
    sharp(base).linear(0.45, 96).png().toBuffer(),
  );
  await add(
    "glare",
    "a reflection washing out one corner",
    sharp(base)
      .composite([
        {
          input: await sharp({
            create: { width: 200, height: 200, channels: 4, background: "#ffffffcc" },
          })
            .png()
            .toBuffer(),
          top: 10,
          left: 10,
          blend: "over",
        },
      ])
      .png()
      .toBuffer(),
  );
  await add(
    "small-160",
    "a code captured at a distance, ~3 device pixels per module",
    sharp(base).resize(160, 160).png().toBuffer(),
  );
  await add(
    "small-blurred-160",
    "the realistic bad case: far away AND out of focus",
    sharp(base).resize(160, 160).blur(1.2).png().toBuffer(),
  );
  await add(
    "noise-and-blur",
    "a cheap sensor in low light",
    sharp(base).blur(1.2).linear(0.8, 24).png().toBuffer(),
  );

  return cases;
}

/**
 * Decode-ready pixels. jsqr wants RGBA; this is the conversion an isomorphic
 * `decodeQr` would do for any caller holding an encoded image, and it is the
 * only place in this rung that knows about image formats at all.
 */
export async function toRgba(png: Buffer): Promise<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}
