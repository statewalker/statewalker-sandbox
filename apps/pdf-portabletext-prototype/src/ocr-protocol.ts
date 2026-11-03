import type { OcrWord } from "./ocr-layout.ts";

/**
 * Messages between the main thread and `ocr.worker.ts`. The worker's language
 * is fixed when it is created (its `name`), so requests do not carry it.
 */
export type OcrRequest = {
  type: "recognize";
  id: number;
  /** Directory URL with `<language>.traineddata` files. */
  modelBaseUrl: string;
  /** Image to recognise; transferred to the worker. */
  image: ImageBitmap;
  /** Factor the image was upscaled by; word rects are divided by it. */
  scale: number;
  /** Estimate the page orientation and turn the image upright first. */
  detectOrientation: boolean;
};

export type OcrResponse =
  | { type: "status"; id: number; message: string }
  | { type: "progress"; id: number; progress: number }
  | {
      type: "result";
      id: number;
      /** Word rects in the upright frame, in pixels of the unscaled image. */
      words: OcrWord[];
      /** Clockwise rotation (0/90/180/270) of the content in the source image. */
      rotation: number;
      durationMs: number;
    }
  | { type: "error"; id: number; message: string };
