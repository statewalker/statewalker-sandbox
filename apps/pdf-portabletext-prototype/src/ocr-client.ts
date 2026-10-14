import type { OcrWord } from "./ocr-layout.ts";
import type { OcrRequest, OcrResponse } from "./ocr-protocol.ts";

/**
 * "Fast" LSTM models: a few MB each and what tesseract-wasm is built for.
 * Override with `?models=<directory url>` to self-host them.
 */
export const DEFAULT_MODEL_BASE_URL =
  "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/";

export type OcrResult = { words: OcrWord[]; durationMs: number };

export type OcrClient = {
  recognize(
    image: ImageBitmap,
    options: {
      language: string;
      scale: number;
      onStatus?: (message: string) => void;
      onProgress?: (percent: number) => void;
    },
  ): Promise<OcrResult>;
  terminate(): void;
};

type Pending = {
  resolve: (r: OcrResult) => void;
  reject: (e: Error) => void;
  onStatus?: (message: string) => void;
  onProgress?: (percent: number) => void;
};

/** Promise wrapper over the dedicated OCR worker. */
export function createOcrClient(modelBaseUrl = DEFAULT_MODEL_BASE_URL): OcrClient {
  const worker = new Worker(new URL("./ocr.worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, Pending>();
  let nextId = 1;

  worker.onmessage = (event: MessageEvent<OcrResponse>) => {
    const msg = event.data;
    const p = pending.get(msg.id);
    if (!p) return;
    switch (msg.type) {
      case "status":
        p.onStatus?.(msg.message);
        break;
      case "progress":
        p.onProgress?.(msg.progress);
        break;
      case "result":
        pending.delete(msg.id);
        p.resolve({ words: msg.words, durationMs: msg.durationMs });
        break;
      case "error":
        pending.delete(msg.id);
        p.reject(new Error(msg.message));
        break;
    }
  };
  worker.onerror = (event) => {
    const error = new Error(`OCR worker failed: ${event.message}`);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };

  return {
    recognize(image, { language, scale, onStatus, onProgress }) {
      const id = nextId++;
      const req: OcrRequest = {
        type: "recognize",
        id,
        language,
        modelBaseUrl,
        image,
        scale,
      };
      return new Promise<OcrResult>((resolve, reject) => {
        pending.set(id, { resolve, reject, onStatus, onProgress });
        worker.postMessage(req, [image]);
      });
    },
    terminate() {
      worker.terminate();
    },
  };
}
