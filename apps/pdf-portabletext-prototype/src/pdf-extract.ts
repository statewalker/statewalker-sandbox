import {
  GlobalWorkerOptions,
  getDocument,
  OPS,
  type PDFDocumentProxy,
  type PDFPageProxy,
  Util,
} from "pdfjs-dist/legacy/build/pdf.mjs";
// The legacy build polyfills recent JS built-ins (e.g. Map#getOrInsertComputed)
// that the modern build of pdf.js 6 relies on.
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PageBox } from "./schema.ts";
import type { TextRun } from "./text-layout.ts";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Directory with pdf.js binary resources, copied there by `vite.config.ts`. */
const resourceUrl = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

export function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return getDocument({
    data: new Uint8Array(data),
    wasmUrl: resourceUrl("wasm"),
    cMapUrl: resourceUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: resourceUrl("standard_fonts"),
    iccUrl: resourceUrl("iccs"),
  }).promise;
}

export function pageSize(page: PDFPageProxy): { width: number; height: number } {
  const { width, height } = page.getViewport({ scale: 1 });
  return { width, height };
}

/** Text-layer runs of a page in top-left point coordinates. */
export async function extractTextRuns(page: PDFPageProxy): Promise<TextRun[]> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const tx = Util.transform(viewport.transform, item.transform);
    const fontSize = Math.hypot(tx[2], tx[3]);
    // Item width is in text space; scale it by the horizontal axis length.
    const scaleX =
      Math.hypot(tx[0], tx[1]) / Math.max(Math.hypot(item.transform[0], item.transform[1]), 1e-6);
    runs.push({
      str: item.str,
      x: tx[4],
      y: tx[5],
      width: item.width * scaleX,
      fontSize,
      hasEOL: item.hasEOL,
    });
  }
  return runs;
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
};

type Matrix = [number, number, number, number, number, number];

/** pdf.js image object, either decoded to an ImageBitmap or raw pixels. */
type PdfjsImage = {
  width: number;
  height: number;
  bitmap?: ImageBitmap;
  data?: Uint8Array | Uint8ClampedArray;
  kind?: number;
};

const IMAGE_KIND = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 } as const;

function getObject(page: PDFPageProxy, objId: string): Promise<PdfjsImage | null> {
  const store = objId.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    try {
      store.get(objId, (obj: PdfjsImage) => resolve(obj ?? null));
    } catch {
      resolve(null);
    }
  });
}

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

async function toBitmap(img: PdfjsImage): Promise<ImageBitmap | null> {
  if (img.bitmap) {
    // pdf.js owns (and may close) its bitmap: take a copy.
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext("2d")?.drawImage(img.bitmap, 0, 0);
    return canvas.transferToImageBitmap();
  }
  const data = toImageData(img);
  return data ? createImageBitmap(data) : null;
}

/** Drawn upright: only scaled and moved (image y axis points up, page y axis down). */
function isUpright(m: Matrix): boolean {
  const eps = 1e-6;
  return Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && m[0] > 0 && m[3] < 0;
}

function unitSquareBox(m: Matrix): PageBox {
  const pts = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map((p) => {
    Util.applyTransform(p, m);
    return p;
  });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, unit: "pt" };
}

/**
 * Raster images painted on a page, with their placement. Walks the operator
 * list tracking the current transformation matrix: an image is painted into
 * the unit square of the CTM, so its page bbox is that square transformed.
 */
export async function extractImages(
  page: PDFPageProxy,
  options: { minSize?: number } = {},
): Promise<ExtractedImage[]> {
  const minSize = options.minSize ?? 24;
  const viewport = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList();
  const placements: { objId: string | null; inline?: PdfjsImage; ctm: Matrix }[] = [];
  let ctm = viewport.transform.slice() as Matrix;
  const stack: Matrix[] = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, args) as Matrix;
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args[0]) && args[0].length === 6)
          ctm = Util.transform(ctm, args[0]) as Matrix;
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintImageXObject:
      case OPS.paintImageXObjectRepeat:
        placements.push({ objId: args[0], ctm });
        break;
      case OPS.paintInlineImageXObject:
        placements.push({ objId: null, inline: args[0], ctm });
        break;
    }
  }

  const images: ExtractedImage[] = [];
  let inlineCount = 0;
  for (const placement of placements) {
    const img = placement.objId ? await getObject(page, placement.objId) : placement.inline;
    if (!img || img.width < minSize || img.height < minSize) continue;
    const bitmap = await toBitmap(img);
    if (!bitmap) continue;
    images.push({
      objId: placement.objId ?? `inline-${inlineCount++}`,
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
      bbox: unitSquareBox(placement.ctm),
      ...(isUpright(placement.ctm)
        ? {}
        : { transform: placement.ctm.map((v) => Math.round(v * 1000) / 1000) }),
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
