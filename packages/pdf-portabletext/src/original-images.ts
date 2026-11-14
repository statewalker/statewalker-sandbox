/**
 * Original JPEG bytes of the images in a PDF, so assets can keep them instead
 * of a re-encoded copy. pdf.js only hands out decoded pixels; pdf-lib (loaded
 * on demand) reads the raw image streams.
 *
 * Only streams that are exactly a baseline JPEG and look the same once
 * decoded by a browser are eligible: DCTDecode as the only filter, 8 bits,
 * gray or RGB, no /Decode array, no soft mask (the alpha would be lost).
 * CMYK JPEGs are left out: browsers and PDF disagree on their (often
 * inverted) colours.
 */
import type { PDFDict, PDFRawStream } from "pdf-lib";

export type OriginalJpeg = { width: number; height: number; bytes: Uint8Array };

/** Eligible JPEG streams per page (1-based), including those inside form XObjects. */
export async function findOriginalJpegs(data: ArrayBuffer): Promise<Map<number, OriginalJpeg[]>> {
  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, PDFRef } = await import(
    "pdf-lib"
  );
  const doc = await PDFDocument.load(data, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
  const name = (s: string) => PDFName.of(s);
  const num = (dict: PDFDict, key: string) => {
    const v = dict.lookup(name(key));
    return v instanceof PDFNumber ? v.asNumber() : undefined;
  };

  function colorComponents(dict: PDFDict): number | undefined {
    let cs = dict.lookup(name("ColorSpace"));
    if (cs === undefined) return undefined;
    if (cs instanceof PDFName) {
      const n = cs.asString();
      if (n === "/DeviceGray" || n === "/CalGray") return 1;
      if (n === "/DeviceRGB" || n === "/CalRGB") return 3;
      return 0;
    }
    if (cs instanceof PDFArray) {
      const kind = cs.lookup(0);
      if (kind instanceof PDFName && kind.asString() === "/ICCBased") {
        cs = cs.lookup(1);
        if (cs instanceof PDFRawStream) return num(cs.dict, "N");
      }
    }
    return 0;
  }

  function eligible(stream: PDFRawStream): OriginalJpeg | null {
    const dict = stream.dict;
    const filter = dict.lookup(name("Filter"));
    const filters =
      filter instanceof PDFName
        ? [filter.asString()]
        : filter instanceof PDFArray
          ? filter.asArray().map((f) => (f instanceof PDFName ? f.asString() : ""))
          : [];
    if (filters.length !== 1 || filters[0] !== "/DCTDecode") return null;
    if (dict.has(name("Decode")) || dict.has(name("SMask")) || dict.has(name("Mask"))) return null;
    if ((num(dict, "BitsPerComponent") ?? 8) !== 8) return null;
    const components = colorComponents(dict);
    if (components !== undefined && components !== 1 && components !== 3) return null;
    const width = num(dict, "Width");
    const height = num(dict, "Height");
    if (!width || !height) return null;
    return { width, height, bytes: stream.contents };
  }

  function collect(resources: PDFDict | undefined, out: OriginalJpeg[], seen: Set<unknown>) {
    const xobjects = resources?.lookup(name("XObject"));
    if (!(xobjects instanceof PDFDict)) return;
    for (const [, value] of xobjects.entries()) {
      if (seen.has(value)) continue;
      seen.add(value);
      const target = value instanceof PDFRef ? doc.context.lookup(value) : value;
      if (!(target instanceof PDFRawStream)) continue;
      const subtype = target.dict.lookup(name("Subtype"));
      if (subtype instanceof PDFName && subtype.asString() === "/Image") {
        const jpeg = eligible(target);
        if (jpeg) out.push(jpeg);
      } else if (subtype instanceof PDFName && subtype.asString() === "/Form") {
        const inner = target.dict.lookup(name("Resources"));
        collect(inner instanceof PDFDict ? inner : undefined, out, seen);
      }
    }
  }

  const result = new Map<number, OriginalJpeg[]>();
  doc.getPages().forEach((page, i) => {
    const out: OriginalJpeg[] = [];
    collect(page.node.Resources(), out, new Set());
    if (out.length > 0) result.set(i + 1, out);
  });
  return result;
}

/** Mean absolute difference (0–255) of two bitmaps compared at 32×32. */
async function difference(a: ImageBitmap, b: ImageBitmap): Promise<number> {
  const sample = (img: ImageBitmap) => {
    const ctx = new OffscreenCanvas(32, 32).getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 32, 32);
    ctx.drawImage(img, 0, 0, 32, 32);
    return ctx.getImageData(0, 0, 32, 32).data;
  };
  const da = sample(a);
  const db = sample(b);
  let sum = 0;
  for (let i = 0; i < da.length; i += 4) {
    sum +=
      Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
  }
  return sum / ((da.length / 4) * 3);
}

/**
 * The original JPEG of an extracted image: same page, same size, and the
 * browser's decoding of it matches pdf.js's pixels (catches colour-space
 * surprises). Several equal-sized candidates are all tried.
 */
export async function matchOriginalJpeg(
  candidates: OriginalJpeg[] | undefined,
  decoded: ImageBitmap,
): Promise<Uint8Array | null> {
  for (const c of candidates ?? []) {
    if (c.width !== decoded.width || c.height !== decoded.height) continue;
    try {
      const bitmap = await createImageBitmap(
        new Blob([c.bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
      );
      const same =
        bitmap.width === decoded.width &&
        bitmap.height === decoded.height &&
        (await difference(bitmap, decoded)) < 8;
      bitmap.close();
      if (same) return c.bytes;
    } catch {
      // Not decodable by the browser: keep the re-encoded copy.
    }
  }
  return null;
}
