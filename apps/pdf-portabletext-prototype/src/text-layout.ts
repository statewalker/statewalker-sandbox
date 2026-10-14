import type { KeyGen } from "./keys.ts";
import type { PageBox, TextBlock } from "./schema.ts";

/** A text run from the PDF text layer, already in top-left page coordinates. */
export type TextRun = {
  str: string;
  x: number;
  /** Baseline y. */
  y: number;
  width: number;
  fontSize: number;
  hasEOL: boolean;
};

export type Paragraph = {
  text: string;
  fontSize: number;
  bbox: PageBox;
};

type Line = {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  fontSize: number;
};

function joinRuns(runs: TextRun[]): Line[] {
  const lines: Line[] = [];
  let line: Line | null = null;
  let last: TextRun | null = null;
  for (const run of runs) {
    if (run.str === "" && !run.hasEOL) continue;
    const sameLine =
      line !== null && last !== null && Math.abs(run.y - last.y) < Math.max(run.fontSize, 1) * 0.5;
    if (!sameLine || line === null) {
      if (line) lines.push(line);
      line = {
        text: "",
        left: run.x,
        right: run.x,
        top: run.y - run.fontSize,
        bottom: run.y + run.fontSize * 0.25,
        fontSize: run.fontSize,
      };
      last = null;
    }
    if (run.str !== "") {
      if (last) {
        const gap = run.x - (last.x + last.width);
        const needsSpace =
          gap > run.fontSize * 0.15 && !/\s$/.test(line.text) && !/^\s/.test(run.str);
        if (needsSpace) line.text += " ";
      }
      line.text += run.str;
      line.left = Math.min(line.left, run.x);
      line.right = Math.max(line.right, run.x + run.width);
      line.top = Math.min(line.top, run.y - run.fontSize);
      line.bottom = Math.max(line.bottom, run.y + run.fontSize * 0.25);
      line.fontSize = Math.max(line.fontSize, run.fontSize);
      last = run;
    }
    if (run.hasEOL) {
      lines.push(line);
      line = null;
      last = null;
    }
  }
  if (line) lines.push(line);
  return lines.filter((l) => l.text.trim() !== "");
}

/** Groups text-layer runs into paragraphs using line spacing and font size. */
export function groupTextRuns(runs: TextRun[]): Paragraph[] {
  const lines = joinRuns(runs);
  const groups: Line[][] = [];
  for (const line of lines) {
    const group = groups[groups.length - 1];
    const prev = group?.[group.length - 1];
    if (prev) {
      const gap = line.top - prev.bottom;
      const sizeRatio = line.fontSize / prev.fontSize;
      const continues =
        gap < line.fontSize * 0.6 && gap > -line.fontSize && sizeRatio > 0.87 && sizeRatio < 1.15;
      if (continues) {
        group.push(line);
        continue;
      }
    }
    groups.push([line]);
  }
  return groups.map((group) => {
    let text = "";
    for (const line of group) {
      const t = line.text.trim();
      if (text === "") text = t;
      else if (/[-­]$/.test(text) && /^\p{Ll}/u.test(t)) text = text.slice(0, -1) + t;
      else text += ` ${t}`;
    }
    const left = Math.min(...group.map((l) => l.left));
    const top = Math.min(...group.map((l) => l.top));
    const right = Math.max(...group.map((l) => l.right));
    const bottom = Math.max(...group.map((l) => l.bottom));
    return {
      text: text.replace(/\s+/g, " "),
      fontSize: Math.max(...group.map((l) => l.fontSize)),
      bbox: { x: left, y: top, width: right - left, height: bottom - top, unit: "pt" },
    };
  });
}

/** Font size covering the most characters: the body text size. */
export function bodyFontSize(paragraphs: Paragraph[]): number {
  const weights = new Map<number, number>();
  for (const p of paragraphs) {
    const size = Math.round(p.fontSize * 2) / 2;
    weights.set(size, (weights.get(size) ?? 0) + p.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best || 10;
}

export function headingStyle(fontSize: number, bodySize: number, text: string): TextBlock["style"] {
  if (text.length > 200) return "normal";
  const ratio = fontSize / bodySize;
  if (ratio >= 1.6) return "h1";
  if (ratio >= 1.3) return "h2";
  if (ratio >= 1.15) return "h3";
  return "normal";
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function roundBox<T extends { x: number; y: number; width: number; height: number }>(
  b: T,
): T {
  return { ...b, x: r2(b.x), y: r2(b.y), width: r2(b.width), height: r2(b.height) };
}

export function paragraphToBlock(
  p: Paragraph,
  options: { keyGen: KeyGen; page: number; bodySize: number },
): TextBlock {
  return {
    _type: "block",
    _key: options.keyGen("b"),
    style: headingStyle(p.fontSize, options.bodySize, p.text),
    markDefs: [],
    children: [{ _type: "span", _key: options.keyGen("s"), text: p.text, marks: [] }],
    source: { type: "pdfText", page: options.page, bbox: roundBox(p.bbox) },
  };
}
