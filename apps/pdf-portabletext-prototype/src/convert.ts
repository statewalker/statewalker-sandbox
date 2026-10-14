import {
  encodeImageAsset,
  type ImageFormat,
  ocrScale,
  type StoredAsset,
  scaleBitmap,
} from "./assets.ts";
import { createKeyGen } from "./keys.ts";
import type { OcrClient } from "./ocr-client.ts";
import { ocrWordsToBlocks } from "./ocr-layout.ts";
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
import { bodyFontSize, groupTextRuns, paragraphToBlock, roundBox } from "./text-layout.ts";

export type ConvertOptions = {
  language: string;
  imageFormat: ImageFormat;
  /** OCR the embedded images. */
  ocrImages: boolean;
  /** Rasterise and OCR pages that have neither a text layer nor images (scans drawn as vectors, etc). */
  ocrEmptyPages: boolean;
  /** Images smaller than this (px, either side) are ignored. */
  minImageSize: number;
  /** OCR words below this confidence are dropped. */
  minConfidence: number;
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

export async function convertPdf(
  file: File,
  ocr: OcrClient,
  options: ConvertOptions,
): Promise<ConvertResult> {
  const log = options.onLog ?? (() => {});
  const pdf = await openPdf(await file.arrayBuffer());
  const pages: PageInfo[] = [];
  const blocks: PortableTextBlock[] = [];
  const assets = new Map<string, StoredAsset>();
  // OCR results are reused when the same asset appears again.
  const ocrCache = new Map<string, Awaited<ReturnType<OcrClient["recognize"]>>>();

  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      options.signal?.throwIfAborted();
      const page = await pdf.getPage(n);
      const size = pageSize(page);
      pages.push({ number: n, width: round2(size.width), height: round2(size.height) });
      const keyGen = createKeyGen(`p${n}-`);
      const items: PageItem[] = [];

      const paragraphs = groupTextRuns(await extractTextRuns(page));
      const bodySize = bodyFontSize(paragraphs);
      for (const p of paragraphs) {
        items.push({
          top: p.bbox.y,
          left: p.bbox.x,
          blocks: [paragraphToBlock(p, { keyGen, page: n, bodySize })],
        });
      }

      let images: (ExtractedImage & { kind: ImageBlock["source"]["type"] })[] = (
        await extractImages(page, { minSize: options.minImageSize })
      ).map((img) => ({ ...img, kind: "pdfImage" as const }));

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
          source: { type: img.kind, page: n, bbox: roundBox(img.bbox) },
        };
        const pageItem: PageItem = { top: img.bbox.y, left: img.bbox.x, blocks: [imageBlock] };
        items.push(pageItem);

        if (options.ocrImages) {
          let result = ocrCache.get(assetId);
          if (!result) {
            const scale = ocrScale(img.width, img.height);
            const input =
              scale === 1
                ? await createImageBitmap(img.bitmap)
                : await scaleBitmap(img.bitmap, scale);
            log(`page ${n}: OCR ${img.width}×${img.height} image (×${scale})`);
            result = await ocr.recognize(input, {
              language: options.language,
              scale,
              onStatus: (m) => log(`page ${n}: ${m}`),
              onProgress: options.onProgress,
            });
            ocrCache.set(assetId, result);
          }
          const textBlocks: TextBlock[] = ocrWordsToBlocks(result.words, {
            keyGen,
            page: n,
            imageKey: imageBlock._key,
            asset,
            minConfidence: options.minConfidence,
          });
          const wordCount = textBlocks.reduce((s, b) => s + b.children.length, 0);
          const confidence =
            textBlocks.length === 0
              ? 0
              : textBlocks.reduce(
                  (s, b) => s + (b.source.type === "ocr" ? b.source.confidence : 0),
                  0,
                ) / textBlocks.length;
          imageBlock.ocr = {
            engine: "tesseract-wasm",
            language: options.language,
            blocks: textBlocks.map((b) => b._key),
            wordCount,
            confidence: Math.round(confidence * 1000) / 1000,
            durationMs: result.durationMs,
          };
          pageItem.blocks.push(...textBlocks);
          log(`page ${n}: ${wordCount} words in ${textBlocks.length} paragraphs`);
        }
        img.bitmap.close();
      }

      // Reading order: top to bottom, then left to right (single-column heuristic).
      items.sort((a, b) => (Math.abs(a.top - b.top) < 2 ? a.left - b.left : a.top - b.top));
      for (const item of items) blocks.push(...item.blocks);
      page.cleanup();
    }
  } finally {
    await pdf.loadingTask.destroy();
  }

  const document: PdfPortableTextDocument = {
    _type: "pdfDocument",
    version: 1,
    title: file.name.replace(/\.pdf$/i, ""),
    source: { fileName: file.name, size: file.size, pageCount: pages.length },
    createdAt: new Date().toISOString(),
    pages,
    blocks,
    assets: Object.fromEntries([...assets].map(([id, a]) => [id, a.meta])),
  };
  return { document, blobs: new Map([...assets].map(([id, a]) => [id, a.blob])) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
