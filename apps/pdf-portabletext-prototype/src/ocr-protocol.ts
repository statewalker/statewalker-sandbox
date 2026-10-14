import type { OcrWord } from "./ocr-layout.ts";

/** Messages between the main thread and `ocr.worker.ts`. */
export type OcrRequest = {
  type: "recognize";
  id: number;
  /** Tesseract language code, e.g. `deu`, `eng`. */
  language: string;
  /** Directory URL with `<language>.traineddata` files. */
  modelBaseUrl: string;
  /** Image to recognise; transferred to the worker. */
  image: ImageBitmap;
  /** Factor the image was upscaled by; word rects are divided by it. */
  scale: number;
};

export type OcrResponse =
  | { type: "status"; id: number; message: string }
  | { type: "progress"; id: number; progress: number }
  | { type: "result"; id: number; words: OcrWord[]; durationMs: number }
  | { type: "error"; id: number; message: string };
