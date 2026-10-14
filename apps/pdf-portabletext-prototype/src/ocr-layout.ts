import type { KeyGen } from "./keys.ts";
import type { AssetReference, OcrBoxMark, PixelBox, Span, TextBlock } from "./schema.ts";

/** Word as reported by the OCR worker, in pixels of the source image. */
export type OcrWord = {
  text: string;
  /** Confidence in [0, 1]. */
  confidence: number;
  rect: { left: number; top: number; right: number; bottom: number };
  startOfLine: boolean;
  endOfLine: boolean;
};

type Line = { words: OcrWord[]; top: number; bottom: number; left: number; right: number };

export type OcrBlocksOptions = {
  keyGen: KeyGen;
  page: number;
  imageKey: string;
  asset: AssetReference;
  /** Words below this confidence are dropped. */
  minConfidence?: number;
};

/** Groups OCR words into lines, then lines into paragraphs. */
export function groupOcrWords(words: OcrWord[]): OcrWord[][][] {
  const lines = splitLines(words);
  if (lines.length === 0) return [];
  const heights = lines.map((l) => l.bottom - l.top).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 1;

  const paragraphs: Line[][] = [[lines[0]]];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const line = lines[i];
    const gap = line.top - prev.bottom;
    const overlapsHorizontally = line.left < prev.right && line.right > prev.left;
    const breaks =
      gap > medianHeight * 0.8 ||
      gap < -medianHeight || // jumped back up: new column / region
      !overlapsHorizontally;
    if (breaks) paragraphs.push([line]);
    else paragraphs[paragraphs.length - 1].push(line);
  }
  return paragraphs.map((p) => p.map((l) => l.words));
}

function splitLines(words: OcrWord[]): Line[] {
  const lines: Line[] = [];
  let current: OcrWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    lines.push({
      words: current,
      top: Math.min(...current.map((w) => w.rect.top)),
      bottom: Math.max(...current.map((w) => w.rect.bottom)),
      left: Math.min(...current.map((w) => w.rect.left)),
      right: Math.max(...current.map((w) => w.rect.right)),
    });
    current = [];
  };
  for (const word of words) {
    if (word.startOfLine) flush();
    current.push(word);
    if (word.endOfLine) flush();
  }
  flush();
  return lines;
}

function toBox(words: OcrWord[]): PixelBox {
  const left = Math.min(...words.map((w) => w.rect.left));
  const top = Math.min(...words.map((w) => w.rect.top));
  const right = Math.max(...words.map((w) => w.rect.right));
  const bottom = Math.max(...words.map((w) => w.rect.bottom));
  return { x: left, y: top, width: right - left, height: bottom - top, unit: "px" };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Converts OCR words of one image into PortableText blocks: one block per
 * paragraph, one span per word, and an `ocrBox` mark per span pointing at the
 * word's bbox in the image.
 */
export function ocrWordsToBlocks(words: OcrWord[], options: OcrBlocksOptions): TextBlock[] {
  const { keyGen, page, imageKey, asset, minConfidence = 0 } = options;
  const kept = words.filter((w) => w.text.trim() !== "" && w.confidence >= minConfidence);
  const blocks: TextBlock[] = [];
  for (const paragraph of groupOcrWords(kept)) {
    const markDefs: OcrBoxMark[] = [];
    const children: Span[] = [];
    paragraph.forEach((line, lineIdx) => {
      line.forEach((word, wordIdx) => {
        const isLastWord = lineIdx === paragraph.length - 1 && wordIdx === line.length - 1;
        const markKey = keyGen("w");
        markDefs.push({
          _type: "ocrBox",
          _key: markKey,
          image: imageKey,
          asset,
          bbox: toBox([word]),
          confidence: round(word.confidence),
        });
        const text = word.text.trim();
        // Words are separated by a trailing space; a hyphen at the end of a line
        // is kept and joins the next line without a space.
        const hyphenated = wordIdx === line.length - 1 && /[-­]$/.test(text);
        const separator = isLastWord || hyphenated ? "" : " ";
        children.push({
          _type: "span",
          _key: keyGen("s"),
          text: text + separator,
          marks: [markKey],
        });
      });
    });
    const allWords = paragraph.flat();
    const confidence = allWords.reduce((s, w) => s + w.confidence, 0) / allWords.length;
    blocks.push({
      _type: "block",
      _key: keyGen("b"),
      style: "normal",
      markDefs,
      children,
      source: {
        type: "ocr",
        page,
        image: imageKey,
        asset,
        bbox: toBox(allWords),
        confidence: round(confidence),
      },
    });
  }
  return blocks;
}
