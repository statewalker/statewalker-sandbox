import {
  encodeImageAsset,
  type ImageFormat,
  ocrScale,
  type StoredAsset,
  scaleBitmap,
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
import {
  type ExtractedImage,
  extractImages,
  extractTextRuns,
  openPdf,
  pageSize,
  renderPage,
} from "./pdf-extract.ts";
import type {
  ImageBlock,
  PageInfo,
  PdfPortableTextDocument,
  PortableTextBlock,
  TextBlock,
} from "./schema.ts";
import {
  bodyFontSize,
  groupTextRuns,
  type Paragraph,
  paragraphToBlock,
  roundBox,
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

type PageItem = { top: number; left: number; blocks: PortableTextBlock[] };
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

export async function convertPdf(
  file: File,
  ocr: OcrPool,
  options: ConvertOptions,
): Promise<ConvertResult> {
  const log = options.onLog ?? (() => {});
  const auto = options.language === "auto";
  const fixedLanguage = auto ? undefined : languageByTesseract(options.language);
  if (!auto && !fixedLanguage) throw new Error(`Unsupported language ${options.language}`);
  const fallback = languageByTesseract(options.fallbackLanguage ?? "") ?? DEFAULT_LANGUAGE;

  const pdf = await openPdf(await file.arrayBuffer());
  const pageCount = Math.min(pdf.numPages, options.maxPages ?? Number.POSITIVE_INFINITY);
  const pages: PageInfo[] = [];
  const blocks: PortableTextBlock[] = [];
  const assets = new Map<string, StoredAsset>();
  // OCR results are reused when the same asset appears again.
  const ocrCache = new Map<string, Promise<OcrOutcome>>();
  const ocrTally = new LanguageTally();
  let textLanguage: Language | undefined;

  /** Language that OCR starts with when nothing better is known yet. */
  const documentLanguage = () => textLanguage ?? ocrTally.dominant();

  async function recognize(img: PageImage, language: Language, page: number) {
    const scale = ocrScale(img.width, img.height);
    const input =
      scale === 1 ? await createImageBitmap(img.bitmap) : await scaleBitmap(img.bitmap, scale);
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
    if (detected && detected !== first) {
      log(`page ${page}: image text looks ${detected.name}, re-running OCR`);
      const second = await recognize(img, detected, page);
      attempts.push(attempt(second));
      if (meanConfidence(second.words) >= meanConfidence(result.words) - 0.05) {
        result = second;
        language = detected;
        languageSource = "detected";
      }
    } else if (detected) {
      languageSource = "detected";
    }
    return { result, language, languageSource, attempts };
  }

  try {
    // Pass 1: text layer of every page. Its language is the starting point for OCR.
    const paragraphsByPage: Paragraph[][] = [];
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n);
      const paragraphs = groupTextRuns(await extractTextRuns(page));
      paragraphsByPage.push(paragraphs);
    }
    // A few stray characters (e.g. an invisible OCR layer of a chart) must not
    // decide the language of a scanned document.
    const allText = paragraphsByPage
      .flat()
      .map((p) => p.text)
      .join(" ")
      .slice(0, 20_000);
    if (letterCount(allText) >= MIN_TEXT_LAYER_LETTERS) textLanguage = detectLanguage(allText);
    if (textLanguage) log(`text layer language: ${textLanguage.name}`);

    // Pass 2: blocks, images and OCR, page by page.
    for (let n = 1; n <= pageCount; n++) {
      options.signal?.throwIfAborted();
      const page = await pdf.getPage(n);
      const size = pageSize(page);
      pages.push({ number: n, width: round2(size.width), height: round2(size.height) });
      const keyGen = createKeyGen(`p${n}-`);
      const items: PageItem[] = [];

      const paragraphs = paragraphsByPage[n - 1];
      const pageLanguage = detectLanguage(paragraphs.map((p) => p.text).join(" ")) ?? textLanguage;
      const bodySize = bodyFontSize(paragraphs);
      for (const p of paragraphs) {
        const block = paragraphToBlock(p, { keyGen, page: n, bodySize });
        const language = detectLanguage(p.text) ?? pageLanguage;
        if (language) block.language = language.bcp47;
        items.push({ top: p.bbox.y, left: p.bbox.x, blocks: [block] });
      }

      let images: PageImage[] = (await extractImages(page, { minSize: options.minImageSize })).map(
        (img) => ({ ...img, kind: "pdfImage" as const }),
      );
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
      for (const img of images) {
        options.signal?.throwIfAborted();
        const stored = await encodeImageAsset(img.bitmap, options.imageFormat);
        const assetId = stored.meta._id;
        if (!assets.has(assetId)) assets.set(assetId, stored);
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
          },
        };
        const pageItem: PageItem = { top: img.bbox.y, left: img.bbox.x, blocks: [imageBlock] };
        items.push(pageItem);
        if (!options.ocrImages) {
          img.bitmap.close();
          continue;
        }

        let outcome = ocrCache.get(assetId);
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
                engine: "tesseract-wasm",
                language: language.bcp47,
                model: language.tesseract,
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
      }
      await Promise.all(ocrJobs);

      // Reading order: top to bottom, then left to right (single-column heuristic).
      items.sort((a, b) => (Math.abs(a.top - b.top) < 2 ? a.left - b.left : a.top - b.top));
      for (const item of items) blocks.push(...item.blocks);
      page.cleanup();
    }
  } finally {
    await pdf.loadingTask.destroy();
  }

  const all = new LanguageTally();
  for (const b of blocks) {
    if (b._type !== "block" || !b.language) continue;
    all.add(
      languageByBcp47(b.language),
      b.children.reduce((s, c) => s + c.text.length, 0),
    );
  }

  const document: PdfPortableTextDocument = {
    _type: "pdfDocument",
    version: 1,
    title: file.name.replace(/\.pdf$/i, ""),
    ...(all.dominant() ? { language: all.dominant()?.bcp47 } : {}),
    source: { fileName: file.name, size: file.size, pageCount: pages.length },
    createdAt: new Date().toISOString(),
    pages,
    blocks,
    assets: Object.fromEntries([...assets].map(([id, a]) => [id, a.meta])),
  };
  return { document, blobs: new Map([...assets].map(([id, a]) => [id, a.blob])) };
}

function attempt(result: OcrResult) {
  return {
    model: result.language,
    confidence: round3(meanConfidence(result.words)),
    words: result.words.length,
  };
}
