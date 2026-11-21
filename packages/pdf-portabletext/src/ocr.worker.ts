/// <reference lib="webworker" />
/**
 * OCR worker built on tesseract-wasm. Each worker serves exactly one language:
 * the language is the worker's `name` (see `ocr-pool.ts`), its model is loaded
 * once and kept for the worker's lifetime. Models are cached in Cache Storage
 * so later sessions work offline.
 */
import {
  createOCREngine,
  layoutFlags,
  type OCREngine,
  supportsFastBuild,
  type TextItem,
} from "tesseract-wasm";
import wasmFastUrl from "tesseract-wasm/dist/tesseract-core.wasm?url";
import wasmFallbackUrl from "tesseract-wasm/dist/tesseract-core-fallback.wasm?url";
import type { OcrWord } from "./ocr-layout.ts";
import type { OcrRequest, OcrResponse } from "./ocr-protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

const MODEL_CACHE = "pdf-portabletext-tessdata";
const language = self.name;

/** Below this confidence an orientation estimate is ignored. */
const MIN_ORIENTATION_CONFIDENCE = 0.6;
/** Mean word confidence under which a rotated reading is attempted. */
const LOW_CONFIDENCE = 0.45;
/** Mean word confidence a rotated reading needs to be kept. */
const GOOD_CONFIDENCE = 0.6;

let enginePromise: Promise<OCREngine> | null = null;

const post = (msg: OcrResponse) => self.postMessage(msg);

async function fetchModel(modelBaseUrl: string): Promise<ArrayBuffer> {
  const url = new URL(`${language}.traineddata`, modelBaseUrl).href;
  const cache = typeof caches !== "undefined" ? await caches.open(MODEL_CACHE) : null;
  const cached = await cache?.match(url);
  if (cached) return cached.arrayBuffer();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cannot download model ${url}: HTTP ${response.status}`);
  await cache?.put(url, response.clone());
  return response.arrayBuffer();
}

function getEngine(req: OcrRequest): Promise<OCREngine> {
  enginePromise ??= (async () => {
    post({ type: "status", id: req.id, message: `loading ${language} model` });
    const wasmUrl = supportsFastBuild() ? wasmFastUrl : wasmFallbackUrl;
    const [wasmBinary, model] = await Promise.all([
      fetch(wasmUrl).then((r) => r.arrayBuffer()),
      fetchModel(req.modelBaseUrl),
    ]);
    const engine = await createOCREngine({ wasmBinary });
    engine.loadModel(model);
    return engine;
  })();
  // A failed load (e.g. network) should not poison the worker forever.
  enginePromise.catch(() => {
    enginePromise = null;
  });
  return enginePromise;
}

/** Rotates a bitmap clockwise by a multiple of 90°. */
function rotate(image: ImageBitmap, degrees: number): ImageBitmap {
  const swap = degrees === 90 || degrees === 270;
  const canvas = new OffscreenCanvas(
    swap ? image.height : image.width,
    swap ? image.width : image.height,
  );
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  if (degrees === 90) ctx.translate(image.height, 0);
  else if (degrees === 180) ctx.translate(image.width, image.height);
  else if (degrees === 270) ctx.translate(0, image.width);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(image, 0, 0);
  return canvas.transferToImageBitmap();
}

type Recognition = { items: TextItem[]; confidence: number; vertical: number };

/** Share of words (3+ characters) whose box is taller than wide: sideways text. */
function verticalShare(items: TextItem[]): number {
  const words = items.filter((i) => i.text.trim().length >= 3);
  if (words.length === 0) return 0;
  const tall = words.filter((i) => i.rect.bottom - i.rect.top > i.rect.right - i.rect.left);
  return tall.length / words.length;
}

function recognizeLoaded(engine: OCREngine, req: OcrRequest): Recognition {
  const items = engine
    .getTextBoxes("word", (progress) => post({ type: "progress", id: req.id, progress }))
    .filter((item) => item.text.trim() !== "");
  const confidence =
    items.length === 0 ? 0 : items.reduce((s, item) => s + item.confidence, 0) / items.length;
  return { items, confidence, vertical: verticalShare(items) };
}

async function recognize(req: OcrRequest): Promise<void> {
  const started = performance.now();
  const engine = await getEngine(req);
  engine.loadImage(req.image);
  let best = recognizeLoaded(engine, req);
  let rotation = 0;

  // Scans are sometimes stored sideways or upside down. The orientation
  // estimate is cheap but can be confidently wrong on upright pages (maps,
  // charts, photos), so it is only tried when the upright reading is poor or
  // sideways, and only kept when the turned reading is good and better.
  // Tesseract can read vertical lines without turning the page, but its
  // reading order and paragraphs are then poor: mostly tall word boxes also
  // trigger a turned reading.
  const sideways = best.vertical > 0.5;
  // Photos without text give no words either way: skip the second pass.
  const hasText = best.items.length >= 3;
  if (req.detectOrientation && hasText && (best.confidence < LOW_CONFIDENCE || sideways)) {
    const orientation = engine.getOrientation();
    if (orientation.rotation !== 0 && orientation.confidence >= MIN_ORIENTATION_CONFIDENCE) {
      const upright = rotate(req.image, (360 - orientation.rotation) % 360);
      engine.loadImage(upright);
      upright.close();
      const turned = recognizeLoaded(engine, req);
      const pct = (r: Recognition) =>
        `${(r.confidence * 100).toFixed(0)}% (${r.items.length} words, ${(r.vertical * 100).toFixed(0)}% vertical)`;
      post({
        type: "status",
        id: req.id,
        message: `orientation: upright ${pct(best)}, turned ${orientation.rotation}° ${pct(turned)}`,
      });
      const better =
        turned.confidence > best.confidence + 0.1 ||
        (sideways && turned.vertical < 0.2 && turned.confidence >= best.confidence - 0.05);
      if (turned.confidence >= GOOD_CONFIDENCE && better) {
        best = turned;
        rotation = orientation.rotation;
      }
    }
  }
  req.image.close();
  engine.clearImage();

  const s = req.scale;
  // Rects stay in the upright frame (needed for line/paragraph grouping);
  // `ocr-layout.ts` maps them back into the source image.
  const words: OcrWord[] = best.items.map((item) => ({
    text: item.text,
    confidence: item.confidence,
    rect: {
      left: Math.round(item.rect.left / s),
      top: Math.round(item.rect.top / s),
      right: Math.round(item.rect.right / s),
      bottom: Math.round(item.rect.bottom / s),
    },
    startOfLine: (item.flags & layoutFlags.StartOfLine) !== 0,
    endOfLine: (item.flags & layoutFlags.EndOfLine) !== 0,
  }));
  post({
    type: "result",
    id: req.id,
    words,
    rotation,
    durationMs: Math.round(performance.now() - started),
  });
}

// Requests are processed one at a time: the engine is synchronous and stateful.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<OcrRequest>) => {
  const req = event.data;
  queue = queue.then(() =>
    recognize(req).catch((err: unknown) =>
      post({
        type: "error",
        id: req.id,
        message: err instanceof Error ? err.message : String(err),
      }),
    ),
  );
};
