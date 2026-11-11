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

export function pageSize(page: PDFPageProxy): { width: number; height: number } {
  const { width, height } = page.getViewport({ scale: 1 });
  return { width, height };
}

/** Text drawn by a page, split by visibility (letters and digits only, no spaces). */
export type TextVisibility = { visible: string; invisible: string };

/** Text rendering modes that paint nothing: 3 (invisible) and 7 (clip only). */
const INVISIBLE_MODES = new Set([3, 7]);
const compact = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Collects the text of every show-text operation, split by text rendering
 * mode. OCR tools (OCRmyPDF, scanners, Acrobat) put the recognised text over
 * the scan in mode 3: `getTextContent` does not tell it apart, this does.
 */
export async function scanTextVisibility(page: PDFPageProxy): Promise<TextVisibility> {
  const opList = await page.getOperatorList();
  let mode = 0;
  const stack: number[] = [];
  const visible: string[] = [];
  const invisible: string[] = [];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(mode);
        break;
      case OPS.restore:
        mode = stack.pop() ?? mode;
        break;
      case OPS.setTextRenderingMode:
        mode = args[0];
        break;
      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText: {
        const glyphs = args[args.length - 1];
        if (!Array.isArray(glyphs)) break;
        let text = "";
        for (const g of glyphs) if (g && typeof g === "object" && g.unicode) text += g.unicode;
        (INVISIBLE_MODES.has(mode) ? invisible : visible).push(compact(text));
        break;
      }
    }
  }
  return { visible: visible.join(""), invisible: invisible.join("") };
}

/** Whether a text run belongs to the invisible part of the page's text. */
export function isInvisibleRun(str: string, visibility: TextVisibility): boolean {
  if (visibility.invisible === "") return false;
  const s = compact(str);
  if (s === "") return visibility.visible === "";
  return visibility.invisible.includes(s) && !visibility.visible.includes(s);
}

type FontInfo = { name?: string; bold?: boolean; black?: boolean; italic?: boolean };

const BOLD_NAME = /bold|black|heavy|semibold|demi|(^|[+-])(cmbx|cmb|sfbx|sfb|ecbx|ecb|lmbx)/i;
const ITALIC_NAME = /italic|oblique|slanted|(^|[+-])(cmti|cmsl|sfti|sfsl|ecti|ecsl|cmbxti|cmbxsl)/i;

/** Bold / italic of a font, from pdf.js flags and the font name (incl. TeX names like CMBX10). */
export function fontStyle(font: FontInfo | null | undefined): { bold: boolean; italic: boolean } {
  const name = (font?.name ?? "").replace(/^[A-Z]{6}\+/, "");
  return {
    bold: !!(font?.bold || font?.black) || BOLD_NAME.test(name),
    italic: !!font?.italic || ITALIC_NAME.test(name),
  };
}

/** Text-layer runs of a page in top-left point coordinates. */
export async function extractTextRuns(page: PDFPageProxy): Promise<TextRun[]> {
  const viewport = page.getViewport({ scale: 1 });
  // The operator list (scanned for visibility) loads the fonts into commonObjs.
  const [content, visibility] = await Promise.all([
    page.getTextContent(),
    scanTextVisibility(page),
  ]);
  const styles = new Map<string, { bold: boolean; italic: boolean }>();
  const styleOf = (fontName: string) => {
    let style = styles.get(fontName);
    if (!style) {
      const font = page.commonObjs.has(fontName)
        ? (page.commonObjs.get(fontName) as FontInfo)
        : null;
      style = fontStyle(font);
      styles.set(fontName, style);
    }
    return style;
  };
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
      ...(isInvisibleRun(item.str, visibility) ? { invisible: true } : {}),
      ...(item.fontName && styleOf(item.fontName).bold ? { bold: true } : {}),
      ...(item.fontName && styleOf(item.fontName).italic ? { italic: true } : {}),
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
