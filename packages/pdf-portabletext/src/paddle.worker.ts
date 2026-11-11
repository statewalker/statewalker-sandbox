/// <reference lib="webworker" />
/**
 * Experimental OCR worker built on PaddleOCR (PP-OCRv4, Chinese + English)
 * through gutenye/ocr and onnxruntime-web. It speaks the same protocol as
 * `ocr.worker.ts`; the model does not depend on the language, so one worker
 * serves every language.
 *
 * PaddleOCR finds text lines, not words: a line's box is split into word
 * boxes in proportion to character offsets, and every word gets the line's
 * confidence.
 */
import "./worker-dom-shim.ts";
import detectionUrl from "@gutenye/ocr-models/assets/ch_PP-OCRv4_det_infer.onnx?url";
import recognitionUrl from "@gutenye/ocr-models/assets/ch_PP-OCRv4_rec_infer.onnx?url";
import dictionaryUrl from "@gutenye/ocr-models/assets/ppocr_keys_v1.txt?url";
import cv from "@techstark/opencv-js";
import { env } from "onnxruntime-web";
import type { OcrWord } from "./ocr-layout.ts";
import type { OcrRequest, OcrResponse } from "./ocr-protocol.ts";
import { readingOrder } from "./reading-order.ts";

declare const self: DedicatedWorkerGlobalScope;

type Line = { text: string; mean: number; box?: number[][] };
type PaddleOcr = {
  detect(image: { data: Uint8ClampedArray; width: number; height: number }): Promise<{
    texts: Line[];
    resizedImageWidth: number;
    resizedImageHeight: number;
  }>;
};

let ocrPromise: Promise<PaddleOcr> | null = null;
const post = (msg: OcrResponse) => self.postMessage(msg);

function opencvReady(): Promise<void> {
  const module = cv as unknown as { Mat?: unknown; onRuntimeInitialized?: () => void };
  if (module.Mat) return Promise.resolve();
  return new Promise((resolve) => {
    module.onRuntimeInitialized = () => resolve();
  });
}

function getOcr(req: OcrRequest): Promise<PaddleOcr> {
  ocrPromise ??= (async () => {
    post({ type: "status", id: req.id, message: "loading PaddleOCR models" });
    // onnxruntime's wasm is served under <base>ort/ by the Vite plugin. One
    // thread: threads need cross-origin isolation, which a static page lacks.
    if (req.runtimeBaseUrl) env.wasm.wasmPaths = req.runtimeBaseUrl;
    env.wasm.numThreads = 1;
    await opencvReady();
    // Imported late so the document shim and onnxruntime settings are in place.
    const { default: Ocr } = await import("@gutenye/ocr-browser");
    return (await Ocr.create({
      models: {
        detectionPath: detectionUrl,
        recognitionPath: recognitionUrl,
        dictionaryPath: dictionaryUrl,
      },
    })) as unknown as PaddleOcr;
  })();
  ocrPromise.catch(() => {
    ocrPromise = null;
  });
  return ocrPromise;
}

/** Splits a line box into word boxes in proportion to character offsets. */
function lineToWords(text: string, rect: OcrWord["rect"], confidence: number): OcrWord[] {
  const chars = text.length || 1;
  const charWidth = (rect.right - rect.left) / chars;
  const words: OcrWord[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index ?? 0;
    words.push({
      text: match[0],
      confidence,
      rect: {
        left: Math.round(rect.left + start * charWidth),
        right: Math.round(rect.left + (start + match[0].length) * charWidth),
        top: rect.top,
        bottom: rect.bottom,
      },
      startOfLine: words.length === 0,
      endOfLine: false,
    });
  }
  if (words.length > 0) words[words.length - 1].endOfLine = true;
  return words;
}

async function recognize(req: OcrRequest): Promise<void> {
  const started = performance.now();
  const ocr = await getOcr(req);
  // Full resolution: downscaling a 300 dpi scan to speed things up costs a
  // third of the words (measured on linn.pdf), and recognition dominates anyway.
  const { width, height } = req.image;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(req.image, 0, 0);
  req.image.close();
  const pixels = ctx.getImageData(0, 0, width, height);
  post({ type: "progress", id: req.id, progress: 10 });
  const result = await ocr.detect({ data: pixels.data, width, height });
  post({ type: "progress", id: req.id, progress: 100 });

  // Boxes are in the detector's resized image; map them to the source pixels.
  const sx = width / result.resizedImageWidth / req.scale;
  const sy = height / result.resizedImageHeight / req.scale;
  const lines = result.texts
    .filter((l) => l.box && l.text.trim() !== "")
    .map((l) => {
      const xs = (l.box as number[][]).map((p) => p[0]);
      const ys = (l.box as number[][]).map((p) => p[1]);
      const rect = {
        left: Math.round(Math.min(...xs) * sx),
        right: Math.round(Math.max(...xs) * sx),
        top: Math.round(Math.min(...ys) * sy),
        bottom: Math.round(Math.max(...ys) * sy),
      };
      return { text: l.text, mean: l.mean, rect };
    });
  // Detection order follows contours: order the lines like page items
  // (columns first), so multi-column scans read column by column.
  const order = readingOrder(
    lines.map((l) => ({
      x: l.rect.left,
      y: l.rect.top,
      width: l.rect.right - l.rect.left,
      height: l.rect.bottom - l.rect.top,
    })),
    { minGutter: 12 },
  );
  const words = order.flatMap((i) => lineToWords(lines[i].text, lines[i].rect, lines[i].mean));
  post({
    type: "result",
    id: req.id,
    words,
    rotation: 0,
    durationMs: Math.round(performance.now() - started),
  });
}

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
