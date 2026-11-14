import {
  encodeImageAsset,
  type ImageFormat,
  jpegAsset,
  ocrInput,
  ocrScale,
  type StoredAsset,
} from "./assets.ts";
import { createKeyGen } from "./keys.ts";
import {
  DEFAULT_LANGUAGE,
  detectLanguage,
  type Language,
  languageByBcp47,
  languageByTesseract,
  letterCount,
  MIN_OCR_LETTERS,
  MIN_TEXT_LAYER_LETTERS,
} from "./languages.ts";
import type { OcrPool, OcrResult } from "./ocr-client.ts";
import { type OcrWord, ocrWordsToBlocks } from "./ocr-layout.ts";
import { findOriginalJpegs, matchOriginalJpeg } from "./original-images.ts";
import {
  type ExtractedImage,
  extractImages,
  extractTextRuns,
  openPdf,
  pageSize,
  renderPage,
} from "./pdf-extract.ts";
import { type OrderBox, readingOrder } from "./reading-order.ts";
import type {
  ImageBlock,
  PageInfo,
  PdfPortableTextDocument,
  PortableTextBlock,
  TextBlock,
} from "./schema.ts";
import { runsToImageWords } from "./text-layer-ocr.ts";
import {
  bodyFontSize,
  layoutText,
  type Paragraph,
  paragraphToBlock,
  roundBox,
  tableToBlock,
} from "./text-layout.ts";

export type ConvertOptions = {
  /** Tesseract model to OCR with, or `auto` to detect the language from the text. */
  language: string;
  /** Model used in `auto` mode until a language has been detected. */
  fallbackLanguage?: string;
  imageFormat: ImageFormat;
  /** OCR the embedded images. */
  ocrImages: boolean;
  /** Rasterise and OCR pages that have neither a text layer nor images (scans drawn as vectors, etc). */
  ocrEmptyPages: boolean;
  /** Turn sideways / upside-down scans upright before OCR. */
  detectOrientation?: boolean;
  /** Images smaller than this (px, either side) are ignored. */
  minImageSize: number;
  /** OCR words below this confidence are dropped. */
  minConfidence: number;
  /** Only the first `maxPages` pages are converted. */
  maxPages?: number;
  /**
   * What to do with invisible text (text rendering mode 3/7), typically the
   * OCR layer another tool put over a scan:
   * - `replace` (default): drop it and OCR the images here, so the text is
   *   not output twice and word boxes come from our OCR;
   * - `reuse`: use it as the OCR result of the image it covers, mapped into
   *   the image's pixels, and skip tesseract for that image;
   * - `keep`: output it like visible text (duplicates the OCR of the image).
   */
  invisibleText?: "replace" | "reuse" | "keep";
  onLog?: (message: string) => void;
  /** OCR progress of the current image, 0..100. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
};

export type ConvertResult = {
  document: PdfPortableTextDocument;
  /** Binary images by asset id. */
  blobs: Map<string, Blob>;
};

type PageItem = { box: OrderBox; blocks: PortableTextBlock[] };
type PageImage = ExtractedImage & { kind: ImageBlock["source"]["type"] };
type OcrOutcome = {
  result: OcrResult;
  language: Language;
  languageSource: NonNullable<ImageBlock["ocr"]>["languageSource"];
  attempts: NonNullable<ImageBlock["ocr"]>["attempts"];
};

const wordsText = (words: OcrWord[]) => words.map((w) => w.text).join(" ");
const meanConfidence = (words: OcrWord[]) =>
  words.length === 0 ? 0 : words.reduce((s, w) => s + w.confidence, 0) / words.length;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Character counts per language; the largest is the dominant language. */
class LanguageTally {
  readonly counts = new Map<Language, number>();
  add(language: Language | undefined, chars: number) {
    if (language) this.counts.set(language, (this.counts.get(language) ?? 0) + chars);
  }
  dominant(): Language | undefined {
    let best: Language | undefined;
    let max = 0;
    for (const [l, n] of this.counts) {
      if (n > max) {
        best = l;
        max = n;
      }
    }
    return best;
  }
}

/** Events of a streamed conversion, in order: `start`, one `page` per page, `end`. */
export type ConvertEvent =
  | { type: "start"; title: string; pageCount: number; source: PdfPortableTextDocument["source"] }
  | {
      type: "page";
      page: PageInfo;
      /** The page's blocks in reading order. */
      blocks: PortableTextBlock[];
      /** Assets first used on this page (an image drawn again later is not repeated). */
      assets: StoredAsset[];
    }
  | { type: "end"; language?: string };

/**
 * Converts a PDF and returns the whole document. For long documents prefer
 * `convertPdfStream`, which hands out each page as soon as it is done.
 */
export async function convertPdf(
  file: File,
  ocr: OcrPool,
  options: ConvertOptions,
): Promise<ConvertResult> {
  const pages: PageInfo[] = [];
  const blocks: PortableTextBlock[] = [];
  const assets = new Map<string, StoredAsset>();
  let source: PdfPortableTextDocument["source"] | undefined;
  let language: string | undefined;
  for await (const event of convertPdfStream(file, ocr, options)) {
    if (event.type === "start") source = event.source;
    else if (event.type === "page") {
      pages.push(event.page);
      blocks.push(...event.blocks);
      for (const a of event.assets) assets.set(a.meta._id, a);
    } else language = event.language;
  }
  const document: PdfPortableTextDocument = {
    _type: "pdfDocument",
    version: 1,
    title: file.name.replace(/\.pdf$/i, ""),
    ...(language ? { language } : {}),
    source: source ?? { fileName: file.name, size: file.size, pageCount: pages.length },
    createdAt: new Date().toISOString(),
    pages,
    blocks,
    assets: Object.fromEntries([...assets].map(([id, a]) => [id, a.meta])),
  };
  return { document, blobs: new Map([...assets].map(([id, a]) => [id, a.blob])) };
}

/** Pages and characters of the text layer sampled to guess the document language. */
const LANGUAGE_SAMPLE_PAGES = 20;
const LANGUAGE_SAMPLE_CHARS = 20_000;

/**
 * Converts a PDF page by page. Each page is extracted, OCR'd and released
 * before the next one starts, so memory stays bounded by one page (plus the
 * assets the consumer keeps); stopping the iteration stops the conversion.
 */
export async function* convertPdfStream(
  file: File,
  ocr: OcrPool,
  options: ConvertOptions,
): AsyncGenerator<ConvertEvent> {
  const log = options.onLog ?? (() => {});
  const auto = options.language === "auto";
  const fixedLanguage = auto ? undefined : languageByTesseract(options.language);
  if (!auto && !fixedLanguage) throw new Error(`Unsupported language ${options.language}`);
  const fallback = languageByTesseract(options.fallbackLanguage ?? "") ?? DEFAULT_LANGUAGE;

  const data = await file.arrayBuffer();
  // pdf.js may take over (detach) the buffer it is given: read originals from a copy.
  const originals =
    options.imageFormat === "original" ? await findOriginalJpegs(data.slice(0)) : undefined;
  const pdf = await openPdf(data);
  const pageCount = Math.min(pdf.numPages, options.maxPages ?? Number.POSITIVE_INFINITY);
  const seenAssets = new Set<string>();
  const allLanguages = new LanguageTally();
  // OCR results are reused when the same asset appears again.
  const ocrCache = new Map<string, Promise<OcrOutcome>>();
  const ocrTally = new LanguageTally();
  let textLanguage: Language | undefined;

  /** Language that OCR starts with when nothing better is known yet. */
  const documentLanguage = () => textLanguage ?? ocrTally.dominant();

  async function recognize(img: PageImage, language: Language, page: number) {
    const scale = ocrScale(img.width, img.height);
    const input = ocrInput(img.bitmap, scale);
    log(
      `page ${page}: OCR ${img.width}×${img.height} image with ${language.tesseract} (×${scale})`,
    );
    return ocr.recognize(language.tesseract, input, {
      scale,
      detectOrientation: options.detectOrientation ?? true,
      onStatus: (m) => log(`page ${page}: ${m}`),
      onProgress: options.onProgress,
    });
  }

  /**
   * OCR with language detection: recognise with the best guess, detect the
   * language of the result, and recognise again with that language's model
   * when it differs. The second pass is kept unless it is clearly worse.
   */
  async function ocrImage(img: PageImage, page: number, pageText: string): Promise<OcrOutcome> {
    if (fixedLanguage) {
      const result = await recognize(img, fixedLanguage, page);
      const attempts = [attempt(result)];
      return { result, language: fixedLanguage, languageSource: "user", attempts };
    }
    const known = documentLanguage();
    const first = known ?? fallback;
    let result = await recognize(img, first, page);
    const attempts = [attempt(result)];
    let language = first;
    let languageSource: OcrOutcome["languageSource"] = known ? "document" : "default";
    // The page's text layer adds evidence; labels of charts or maps alone are
    // too short to tell the language reliably.
    const text = `${wordsText(result.words)} ${pageText}`;
    const detected = letterCount(text) >= MIN_OCR_LETTERS ? detectLanguage(text) : undefined;
    if (detected && detected !== first && !ocr.languageIndependent) {
      log(`page ${page}: image text looks ${detected.name}, re-running OCR`);
      const second = await recognize(img, detected, page);
      attempts.push(attempt(second));
      if (meanConfidence(second.words) >= meanConfidence(result.words) - 0.05) {
        result = second;
        language = detected;
        languageSource = "detected";
      }
    } else if (detected) {
      // Confirmed, or (language-independent engine) only a label for the text.
      language = detected;
      languageSource = "detected";
    }
    return { result, language, languageSource, attempts };
  }

  try {
    yield {
      type: "start",
      title: file.name.replace(/\.pdf$/i, ""),
      pageCount,
      source: { fileName: file.name, size: file.size, pageCount },
    };

    // Language of the text layer, from a sample of the first pages (text only:
    // no operator lists, so no image is decoded here). It is where OCR starts.
    let sample = "";
    for (let n = 1; n <= Math.min(pageCount, LANGUAGE_SAMPLE_PAGES); n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      for (const item of content.items) if ("str" in item) sample += `${item.str} `;
      if (sample.length >= LANGUAGE_SAMPLE_CHARS) break;
    }
    // A few stray characters (e.g. an invisible OCR layer of a chart) must not
    // decide the language of a scanned document.
    sample = sample.slice(0, LANGUAGE_SAMPLE_CHARS);
    if (letterCount(sample) >= MIN_TEXT_LAYER_LETTERS) textLanguage = detectLanguage(sample);
    if (textLanguage) log(`text layer language: ${textLanguage.name}`);
    // Without OCR nothing would replace or reuse an invisible text layer: keep it as text.
    const invisibleMode = options.ocrImages ? (options.invisibleText ?? "replace") : "keep";

    // Blocks, images and OCR, page by page.
    for (let n = 1; n <= pageCount; n++) {
      options.signal?.throwIfAborted();
      const page = await pdf.getPage(n);
      const size = pageSize(page);
      const pageInfo = { number: n, width: round2(size.width), height: round2(size.height) };
      const pageAssets: StoredAsset[] = [];
      const keyGen = createKeyGen(`p${n}-`);
      const items: PageItem[] = [];

      const runs = await extractTextRuns(page);
      let images: PageImage[] = (await extractImages(page, { minSize: options.minImageSize })).map(
        (img) => ({ ...img, kind: "pdfImage" as const }),
      );
      // Invisible runs stand for the text of the images under them; runs over no image have
      // nothing to replace or reuse them, so they stay in the text layer.
      const overImage = (r: (typeof runs)[number]) => {
        const cx = r.x + r.width / 2;
        const cy = r.y - r.fontSize / 2;
        return images.some(
          (img) =>
            cx >= img.bbox.x &&
            cx <= img.bbox.x + img.bbox.width &&
            cy >= img.bbox.y &&
            cy <= img.bbox.y + img.bbox.height,
        );
      };
      const invisibleRuns =
        invisibleMode === "keep" ? [] : runs.filter((r) => r.invisible && overImage(r));
      if (invisibleRuns.length > 0) {
        log(
          `page ${n}: invisible text layer (${invisibleRuns.length} runs) ${invisibleMode === "reuse" ? "reused as OCR" : "replaced by OCR"}`,
        );
      }
      const dropped = new Set(invisibleRuns);
      const layout = layoutText(runs.filter((r) => !dropped.has(r)));
      const paragraphs = layout.paragraphs;
      const pageLanguage = detectLanguage(paragraphs.map((p) => p.text).join(" ")) ?? textLanguage;
      const bodySize = bodyFontSize(paragraphs);
      for (const p of paragraphs) {
        const block = paragraphToBlock(p, { keyGen, page: n, bodySize });
        const language = detectLanguage(p.text) ?? pageLanguage;
        if (language) block.language = language.bcp47;
        items.push({ box: p.bbox, blocks: [block] });
      }
      for (const t of layout.tables) {
        items.push({ box: t.bbox, blocks: [tableToBlock(t, { keyGen, page: n })] });
      }

      if (paragraphs.length === 0 && images.length === 0 && options.ocrEmptyPages) {
        log(`page ${n}: no text layer or images, rendering the page for OCR`);
        const bitmap = await renderPage(page);
        images = [
          {
            objId: "page",
            bitmap,
            width: bitmap.width,
            height: bitmap.height,
            bbox: { x: 0, y: 0, width: size.width, height: size.height, unit: "pt" },
            kind: "pageRender",
          },
        ];
      }
      log(`page ${n}: ${paragraphs.length} text paragraphs, ${images.length} images`);

      // Images of a page are recognised concurrently: one worker per language.
      const ocrJobs: Promise<void>[] = [];
      // Bitmaps not yet handed to an OCR job (or closed): released if the page fails.
      const unreleased = new Set(images);
      try {
        for (const img of images) {
          options.signal?.throwIfAborted();
          const original =
            originals && img.kind === "pdfImage" && !img.stencil
              ? await matchOriginalJpeg(originals.get(n), img.bitmap)
              : null;
          const stored = original
            ? await jpegAsset(original, img.width, img.height)
            : await encodeImageAsset(
                img.bitmap,
                options.imageFormat === "original" ? "png" : options.imageFormat,
              );
          const assetId = stored.meta._id;
          if (!seenAssets.has(assetId)) {
            seenAssets.add(assetId);
            pageAssets.push(stored);
          }
          const asset = { _type: "reference" as const, _ref: assetId };
          const imageBlock: ImageBlock = {
            _type: "image",
            _key: keyGen("img"),
            asset,
            width: img.width,
            height: img.height,
            mimeType: stored.meta.mimeType,
            source: {
              type: img.kind,
              page: n,
              bbox: roundBox(img.bbox),
              ...(img.transform ? { transform: img.transform } : {}),
              ...(img.stencil ? { stencil: true } : {}),
            },
          };
          const pageItem: PageItem = { box: img.bbox, blocks: [imageBlock] };
          items.push(pageItem);
          if (!options.ocrImages) {
            unreleased.delete(img);
            img.bitmap.close();
            continue;
          }

          let outcome = ocrCache.get(assetId);
          if (!outcome && invisibleMode === "reuse" && !img.transform) {
            const words = runsToImageWords(invisibleRuns, img);
            if (words.length >= 3) {
              log(`page ${n}: reusing ${words.length} words of the invisible text layer`);
              outcome = Promise.resolve(
                reusedOutcome(words, paragraphs, documentLanguage() ?? fallback),
              );
              ocrCache.set(assetId, outcome);
            }
          }
          if (!outcome) {
            outcome = ocrImage(img, n, paragraphs.map((p) => p.text).join(" "));
            ocrCache.set(assetId, outcome);
          }
          ocrJobs.push(
            outcome
              .then(({ result, language, languageSource, attempts }) => {
                const textBlocks: TextBlock[] = ocrWordsToBlocks(result.words, {
                  keyGen,
                  page: n,
                  imageKey: imageBlock._key,
                  asset,
                  minConfidence: options.minConfidence,
                  language: language.bcp47,
                  rotation: result.rotation,
                  imageWidth: img.width,
                  imageHeight: img.height,
                });
                const recognised = textBlocks.map((b) => b.children.map((c) => c.text).join(""));
                ocrTally.add(
                  languageSource === "detected" ? language : undefined,
                  recognised.join(" ").length,
                );
                const wordCount = textBlocks.reduce((s, b) => s + b.children.length, 0);
                const kept = result.words.filter(
                  (w) => w.text.trim() !== "" && w.confidence >= options.minConfidence,
                );
                imageBlock.ocr = {
                  engine: result.engine ?? "tesseract-wasm",
                  language: language.bcp47,
                  model: result.engine === "pdf-text-layer" ? "" : language.tesseract,
                  languageSource,
                  attempts,
                  rotation: result.rotation,
                  blocks: textBlocks.map((b) => b._key),
                  wordCount,
                  confidence: round3(meanConfidence(kept)),
                  durationMs: result.durationMs,
                };
                pageItem.blocks.push(...textBlocks);
                const rotated = result.rotation ? `, rotated ${result.rotation}°` : "";
                log(
                  `page ${n}: ${wordCount} words in ${textBlocks.length} paragraphs (${language.name}, ${languageSource}${rotated})`,
                );
              })
              .finally(() => img.bitmap.close()),
          );
          unreleased.delete(img);
        }
        // Cancel interrupts the page's OCR too, not only the loop between images.
        await untilAborted(Promise.all(ocrJobs), options.signal);
      } catch (e) {
        for (const img of unreleased) img.bitmap.close();
        // Jobs still running settle later; nobody waits for them (that would undo a cancel).
        for (const job of ocrJobs) job.catch(() => {});
        throw e;
      }

      // Reading order: XY-cut over the page's paragraphs and images (columns
      // left to right, rows top to bottom); OCR text stays after its image.
      const ordered = readingOrder(items.map((item) => item.box));
      const pageBlocks = ordered.flatMap((index) => items[index].blocks);
      for (const b of pageBlocks) {
        if (b._type !== "block" || !b.language) continue;
        const chars = b.children.reduce((sum, c) => sum + c.text.length, 0);
        allLanguages.add(languageByBcp47(b.language), chars);
      }
      // Release the page's decoded images and fonts before the next one.
      page.cleanup();
      yield { type: "page", page: pageInfo, blocks: pageBlocks, assets: pageAssets };
    }
    yield { type: "end", language: allLanguages.dominant()?.bcp47 };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** OCR outcome built from an existing (invisible) text layer instead of tesseract. */
function reusedOutcome(words: OcrWord[], paragraphs: Paragraph[], guess: Language): OcrOutcome {
  const text = `${wordsText(words)} ${paragraphs.map((p) => p.text).join(" ")}`;
  const detected = letterCount(text) >= MIN_OCR_LETTERS ? detectLanguage(text) : undefined;
  return {
    result: { language: "", engine: "pdf-text-layer", words, rotation: 0, durationMs: 0 },
    language: detected ?? guess,
    languageSource: detected ? "detected" : "document",
    attempts: [],
  };
}

function attempt(result: OcrResult) {
  return {
    model: result.language,
    confidence: round3(meanConfidence(result.words)),
    words: result.words.length,
  };
}

/** `promise`, or a rejection as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
