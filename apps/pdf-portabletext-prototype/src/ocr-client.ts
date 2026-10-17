import type { OcrWord } from "./ocr-layout.ts";
import type { OcrRequest, OcrResponse } from "./ocr-protocol.ts";

/**
 * "Fast" LSTM models: a few MB each and what tesseract-wasm is built for.
 * Override with `?models=<directory url>` to self-host them.
 */
export const DEFAULT_MODEL_BASE_URL =
  "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/";

export type OcrResult = {
  /** Tesseract language the text was recognised with. */
  language: string;
  words: OcrWord[];
  rotation: number;
  durationMs: number;
};

export type RecognizeOptions = {
  scale: number;
  detectOrientation?: boolean;
  onStatus?: (message: string) => void;
  onProgress?: (percent: number) => void;
};

type Pending = {
  resolve: (r: OcrResult) => void;
  reject: (e: Error) => void;
  onStatus?: (message: string) => void;
  onProgress?: (percent: number) => void;
};

/** One worker, one language. */
class LanguageWorker {
  readonly worker: Worker;
  readonly pending = new Map<number, Pending>();
  lastUsed = 0;

  constructor(
    readonly language: string,
    readonly modelBaseUrl: string,
  ) {
    this.worker = new Worker(new URL("./ocr.worker.ts", import.meta.url), {
      type: "module",
      name: language,
    });
    this.worker.onmessage = (event: MessageEvent<OcrResponse>) => {
      const msg = event.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      switch (msg.type) {
        case "status":
          p.onStatus?.(msg.message);
          break;
        case "progress":
          p.onProgress?.(msg.progress);
          break;
        case "result":
          this.pending.delete(msg.id);
          p.resolve({
            language,
            words: msg.words,
            rotation: msg.rotation,
            durationMs: msg.durationMs,
          });
          break;
        case "error":
          this.pending.delete(msg.id);
          p.reject(new Error(msg.message));
          break;
      }
    };
    this.worker.onerror = (event) => this.fail(new Error(`OCR worker failed: ${event.message}`));
  }

  recognize(id: number, image: ImageBitmap, options: RecognizeOptions): Promise<OcrResult> {
    this.lastUsed = performance.now();
    const req: OcrRequest = {
      type: "recognize",
      id,
      modelBaseUrl: this.modelBaseUrl,
      image,
      scale: options.scale,
      detectOrientation: options.detectOrientation ?? true,
    };
    return new Promise<OcrResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        onStatus: options.onStatus,
        onProgress: options.onProgress,
      });
      this.worker.postMessage(req, [image]);
    });
  }

  fail(error: Error) {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  terminate() {
    this.worker.terminate();
    this.fail(new Error("OCR worker terminated"));
  }
}

export type OcrPool = {
  /** Recognises `image` with the worker dedicated to `language` (created on demand). */
  recognize(language: string, image: ImageBitmap, options: RecognizeOptions): Promise<OcrResult>;
  /** Languages that currently have a worker. */
  languages(): string[];
  terminate(): void;
};

/**
 * One worker per language. Workers for different languages run in parallel;
 * requests for the same language queue in its worker. At most `maxWorkers`
 * are kept (each holds a wasm heap and a model): the least recently used idle
 * worker is dropped to make room.
 */
export function createOcrPool(
  options: { modelBaseUrl?: string; maxWorkers?: number } = {},
): OcrPool {
  const modelBaseUrl = options.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL;
  const maxWorkers = options.maxWorkers ?? 4;
  const workers = new Map<string, LanguageWorker>();
  let nextId = 1;

  function get(language: string): LanguageWorker {
    let w = workers.get(language);
    if (w) return w;
    if (workers.size >= maxWorkers) {
      const idle = [...workers.values()]
        .filter((x) => x.pending.size === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle) {
        idle.terminate();
        workers.delete(idle.language);
      }
    }
    w = new LanguageWorker(language, modelBaseUrl);
    workers.set(language, w);
    return w;
  }

  return {
    recognize(language, image, opts) {
      return get(language).recognize(nextId++, image, opts);
    },
    languages() {
      return [...workers.keys()];
    },
    terminate() {
      for (const w of workers.values()) w.terminate();
      workers.clear();
    },
  };
}
