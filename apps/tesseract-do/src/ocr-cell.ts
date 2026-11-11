/**
 * One OCR cell: a Durable Object holding a tesseract-wasm engine. The engine
 * (wasm instance plus the language model) stays in memory between requests;
 * the model also survives restarts in the cell's SQLite. Cells are named per
 * language by the Worker (`ocr-<lang>`), mirroring the browser's one worker
 * per language: each holds one model, and different languages run in
 * different cells, in parallel.
 *
 * Requests to one cell run one at a time: recognition is synchronous
 * compute, so the cell's input gate holds the next request until it ends.
 */
import { DurableObject } from "cloudflare:workers";
import tesseractWasm from "../node_modules/tesseract-wasm/dist/tesseract-core.wasm";
import { decodeImage } from "./decode.ts";
import {
  checkLang,
  initModelTable,
  loadModel,
  type ModelSource,
  type Sql,
  storedModels,
} from "./models.ts";
import {
  createEngine,
  type Engine,
  type OcrResult,
  type RecognizeOptions,
  recognize,
  wasmMemoryBytes,
} from "./ocr.ts";

export interface Env {
  OCR: DurableObjectNamespace<OcrCell>;
  LOADER?: unknown;
  /** Directory URL of `<lang>.traineddata` files. */
  MODEL_BASE_URL?: string;
}

export const DEFAULT_MODEL_BASE_URL =
  "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/";

export type CellOcrResult = OcrResult & {
  lang: string;
  cell: { bootId: string; requests: number };
  model: { source: ModelSource; bytes: number };
  /** Bands the image was read in. */
  bands: number;
  /** Linear memory of the wasm instance after this run, in MiB (it never shrinks). */
  wasmMemoryMiB: number;
  /** The compact decoded image held in JS during the run, in MiB. */
  decodedMiB: number;
};

// Generated on first use: workerd refuses random values at global scope.
let bootIdValue: string | undefined;
const bootId = () => {
  bootIdValue ??= crypto.randomUUID();
  return bootIdValue;
};
const mib = (n: number) => Math.round((n / 2 ** 20) * 10) / 10;

export class OcrCell extends DurableObject<Env> {
  readonly #sql: Sql;
  readonly #engines = new Map<string, Promise<Engine>>();
  readonly #modelBytes = new Map<string, number>();
  #requests = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql as unknown as Sql;
    initModelTable(this.#sql);
  }

  async ocr(
    image: ArrayBuffer,
    lang: string,
    options: RecognizeOptions = {},
  ): Promise<CellOcrResult> {
    checkLang(lang);
    this.#requests++;
    let modelSource: ModelSource = "memory";
    let engine = this.#engines.get(lang);
    if (!engine) {
      engine = (async () => {
        const base = this.env.MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL;
        const model = await loadModel(this.#sql, lang, base);
        modelSource = model.source;
        this.#modelBytes.set(lang, model.bytes.byteLength);
        return createEngine(tesseractWasm, model.bytes);
      })();
      this.#engines.set(lang, engine);
      engine.catch(() => this.#engines.delete(lang));
    }
    const ready = await engine;
    const source = decodeImage(new Uint8Array(image));
    const result = recognize(ready, source, options);
    return {
      ...result,
      lang,
      cell: { bootId: bootId(), requests: this.#requests },
      model: { source: modelSource, bytes: this.#modelBytes.get(lang) ?? 0 },
      wasmMemoryMiB: mib(wasmMemoryBytes(ready)),
      decodedMiB: mib(source.bytes),
    };
  }

  async stats() {
    return {
      bootId: bootId(),
      requests: this.#requests,
      enginesLoaded: [...this.#engines.keys()],
      models: storedModels(this.#sql),
    };
  }
}
