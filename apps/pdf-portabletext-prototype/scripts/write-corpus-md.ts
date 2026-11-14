/**
 * Writes CORPUS.md from the reports of `pnpm corpus` (tesseract) and, when
 * present, `pnpm corpus --engine=paddle`: the full results table and a
 * side-by-side comparison of the two engines on the files both ran.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tesseract = join(root, "e2e-output", "corpus", "report.md");
const paddle = join(root, "e2e-output", "corpus-paddle", "report.md");

type Row = { name: string; cells: string[] };
const rows = (path: string): Row[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("| ["))
    .map((l) => {
      const cells = l.slice(2, -2).split(" | ");
      return { name: cells[0].replace(/^\[([^\]]+)\].*$/, "$1"), cells };
    });

const main = rows(tesseract);
const passed = main.filter((r) => r.cells[6].startsWith("✓")).length;
let out = `# Test corpus results

Output of \`pnpm corpus:fetch && pnpm corpus\` (headless Chromium, language auto-detected with
English as the fallback, tesseract OCR, original JPEGs kept). **${passed}/${main.length} runs pass.**
Sources and licenses of every file are in
[\`scripts/corpus-manifest.ts\`](scripts/corpus-manifest.ts); downloaded files are not committed,
built fixtures come from \`scripts/make-*.ts\`.

Columns: detected document language; number of image blocks; for each image the model whose
reading was kept and how it was chosen (\`detected\` from the OCR text, \`document\` from the text
layer or earlier pages, \`default\` = fallback English; \`after a→b\` lists the models tried), the
rotation corrected before OCR and the mean word confidence; checks (recall = share of transcript
words found, order = share of transcript word pairs found).

| File | What it exercises | Lang | Images | OCR (model, source, rotation, conf.) | Time | Checks |
| --- | --- | --- | --- | --- | --- | --- |
${main.map((r) => `| ${r.cells.join(" | ")} |`).join("\n")}
`;

if (existsSync(paddle)) {
  const other = new Map(rows(paddle).map((r) => [r.name, r]));
  const both = main.filter((r) => other.has(r.name));
  const verdict = (cells: string[]) => {
    const result = cells[6];
    if (result.startsWith("✓")) return "✓";
    return `✗ ${result
      .slice(2)
      .split("; ")
      .map((c) => c.replace(/ \(min [^)]*\)/, "").trim())
      .join("; ")}`;
  };
  const metric = (cells: string[], name: string) =>
    cells[6].match(new RegExp(`${name} ([\\d.]+%)`))?.[1] ?? "";
  out += `
## Tesseract vs. PaddleOCR (experimental)

\`pnpm corpus --engine=paddle\` on the OCR-heavy files: PaddleOCR (PP-OCRv4, Chinese + English)
through gutenye/ocr and onnxruntime-web, single-threaded wasm in a worker. It recognises lines,
not words (word boxes are split in proportion), has no diacritics and no orientation detection.

| File | Tesseract | Time | PaddleOCR | Time |
| --- | --- | --- | --- | --- |
${both
  .map((r) => {
    const p = other.get(r.name) as Row;
    const extra = (cells: string[]) => {
      const recall = metric(cells, "recall");
      const order = metric(cells, "order");
      return [recall && `recall ${recall}`, order && `order ${order}`].filter(Boolean).join(", ");
    };
    const t = [verdict(r.cells), extra(r.cells)].filter(Boolean).join(" · ");
    const q = [verdict(p.cells), extra(p.cells)].filter(Boolean).join(" · ");
    return `| ${r.name} | ${t} | ${r.cells[5]} | ${q} | ${p.cells[5]} |`;
  })
  .join("\n")}
`;
}

writeFileSync(join(root, "CORPUS.md"), out);
console.log(
  `wrote CORPUS.md (${main.length} runs${existsSync(paddle) ? ", with the engine comparison" : ""})`,
);
