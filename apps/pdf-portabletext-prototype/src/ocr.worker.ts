/// <reference lib="webworker" />
/**
 * Dedicated OCR worker built on tesseract-wasm. One engine instance lives for
 * the lifetime of the worker; language models are downloaded once and kept in
 * Cache Storage so later sessions work offline.
 */
import { createOCREngine, layoutFlags, type OCREngine, supportsFastBuild } from "tesseract-wasm";
import wasmFastUrl from "tesseract-wasm/dist/tesseract-core.wasm?url";
import wasmFallbackUrl from "tesseract-wasm/dist/tesseract-core-fallback.wasm?url";
import type { OcrWord } from "./ocr-layout.ts";
import type { OcrRequest, OcrResponse } from "./ocr-protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

const MODEL_CACHE = "pdf-portabletext-tessdata";

let enginePromise: Promise<OCREngine> | null = null;
let loadedModel: string | null = null;

const post = (msg: OcrResponse) => self.postMessage(msg);

function getEngine(): Promise<OCREngine> {
  enginePromise ??= (async () => {
    const url = supportsFastBuild() ? wasmFastUrl : wasmFallbackUrl;
    const wasmBinary = await (await fetch(url)).arrayBuffer();
    return createOCREngine({ wasmBinary });
  })();
  return enginePromise;
}

async function fetchModel(baseUrl: string, language: string): Promise<ArrayBuffer> {
  const url = new URL(`${language}.traineddata`, baseUrl).href;
  const cache = typeof caches !== "undefined" ? await caches.open(MODEL_CACHE) : null;
  const cached = await cache?.match(url);
  if (cached) return cached.arrayBuffer();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cannot download model ${url}: HTTP ${response.status}`);
  await cache?.put(url, response.clone());
  return response.arrayBuffer();
}

async function recognize(req: OcrRequest): Promise<void> {
  const started = performance.now();
  const engine = await getEngine();
  const modelUrl = new URL(`${req.language}.traineddata`, req.modelBaseUrl).href;
  if (loadedModel !== modelUrl) {
    post({ type: "status", id: req.id, message: `loading ${req.language} model` });
    engine.loadModel(await fetchModel(req.modelBaseUrl, req.language));
    loadedModel = modelUrl;
  }
  engine.loadImage(req.image);
  req.image.close();
  const items = engine.getTextBoxes("word", (progress) =>
    post({ type: "progress", id: req.id, progress }),
  );
  engine.clearImage();
  const s = req.scale;
  const words: OcrWord[] = items.map((item) => ({
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
  post({ type: "result", id: req.id, words, durationMs: Math.round(performance.now() - started) });
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
