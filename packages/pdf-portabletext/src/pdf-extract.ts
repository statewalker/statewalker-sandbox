import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
// The legacy build polyfills recent JS built-ins (e.g. Map#getOrInsertComputed)
// that the modern build of pdf.js 6 relies on.
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { IMAGE_KIND, type PdfjsImage, scanImagePlacements } from "./pdf-scan.ts";
import type { PageBox } from "./schema.ts";

export {
  extractTextRuns,
  fontStyle,
  isInvisibleRun,
  pageSize,
  scanTextVisibility,
  type TextVisibility,
} from "./pdf-scan.ts";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Directory URL holding pdf.js binary resources (`wasm/`, `cmaps/`,
 * `standard_fonts/`, `iccs/`). The Vite plugin (`@statewalker/pdf-portabletext/vite`)
 * serves and emits them under `<base>pdfjs/`, the default.
 */
let resourceBaseUrl: string | undefined;

export function configurePdfjs(options: { resourceBaseUrl?: string }): void {
  resourceBaseUrl = options.resourceBaseUrl;
}

const resourceUrl = (dir: string) =>
  new URL(`${dir}/`, resourceBaseUrl ?? new URL("pdfjs/", document.baseURI)).href;

export function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return getDocument({
    data: new Uint8Array(data),
    wasmUrl: resourceUrl("wasm"),
    cMapUrl: resourceUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: resourceUrl("standard_fonts"),
    iccUrl: resourceUrl("iccs"),
    // Font names are needed to tell bold and italic text apart.
    fontExtraProperties: true,
  }).promise;
}

export type ExtractedImage = {
  /** pdf.js object id; the same XObject drawn twice keeps the same id. */
  objId: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  bbox: PageBox;
  /**
   * Set when the image is not drawn upright (rotated, flipped or skewed): maps the image's unit
   * square to page points (top-left origin); (0,1) is the image's top-left corner.
   */
  transform?: number[];
  /** A 1-bit stencil mask: painted pixels are black, the rest transparent. */
  stencil?: boolean;
};

function toImageData(img: PdfjsImage): ImageData | null {
  const { width, height, data, kind } = img;
  if (!data) return null;
  const out = new ImageData(width, height);
  const dst = out.data;
  if (kind === IMAGE_KIND.RGBA_32BPP) {
    dst.set(data.subarray(0, dst.length));
  } else if (kind === IMAGE_KIND.RGB_24BPP) {
    for (let i = 0, j = 0; j < dst.length; i += 3, j += 4) {
      dst[j] = data[i];
      dst[j + 1] = data[i + 1];
      dst[j + 2] = data[i + 2];
      dst[j + 3] = 255;
    }
  } else if (kind === IMAGE_KIND.GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const j = (y * width + x) * 4;
        dst[j] = dst[j + 1] = dst[j + 2] = v;
        dst[j + 3] = 255;
      }
    }
  } else {
    return null;
  }
  return out;
}

/**
 * Decodes a stencil mask. pdf.js has already applied the mask's /Decode:
 * a 0 bit is painted (with the fill colour; black here), a 1 bit is not.
 */
async function maskToBitmap(img: PdfjsImage): Promise<ImageBitmap | null> {
  const { width, height } = img;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  if (img.bitmap) {
    ctx.drawImage(img.bitmap as ImageBitmap, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
  } else if (img.data && img.data.length === width * height * 4) {
    // Large masks arrive already expanded to RGBA (painted = opaque black).
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), width, height), 0, 0);
  } else if (img.data) {
    const out = new ImageData(width, height);
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (img.data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (bit === 0) out.data[(y * width + x) * 4 + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
  } else {
    return null;
  }
  // A mask that paints nothing shows nothing: not worth an image.
  const alpha = ctx.getImageData(0, 0, width, height).data;
  let painted = false;
  for (let i = 3; i < alpha.length && !painted; i += 4) painted = alpha[i] > 0;
  return painted ? canvas.transferToImageBitmap() : null;
}

async function toBitmap(img: PdfjsImage): Promise<ImageBitmap | null> {
  if (img.bitmap) {
    // pdf.js owns (and may close) its bitmap: take a copy.
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext("2d")?.drawImage(img.bitmap as ImageBitmap, 0, 0);
    return canvas.transferToImageBitmap();
  }
  const data = toImageData(img);
  return data ? createImageBitmap(data) : null;
}

/** Raster images painted on a page, as bitmaps, with their placement (see `scanImagePlacements`). */
export async function extractImages(
  page: PDFPageProxy,
  options: { minSize?: number } = {},
): Promise<ExtractedImage[]> {
  const images: ExtractedImage[] = [];
  for (const p of await scanImagePlacements(page, options)) {
    const bitmap = p.stencil ? await maskToBitmap(p.image) : await toBitmap(p.image);
    if (!bitmap) continue;
    images.push({
      objId: p.objId,
      ...(p.stencil ? { stencil: true } : {}),
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
      bbox: p.bbox,
      ...(p.transform ? { transform: p.transform } : {}),
    });
  }
  return images;
}

/** Renders a whole page to a bitmap (fallback for pages without text or images). */
export async function renderPage(page: PDFPageProxy, dpi = 200): Promise<ImageBitmap> {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return createImageBitmap(canvas);
}
