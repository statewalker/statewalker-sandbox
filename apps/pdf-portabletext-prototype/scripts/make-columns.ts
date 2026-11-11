/**
 * Builds a two-column test page with a known reading order: a full-width
 * title, two columns of paragraphs and a full-width footer. Lines are drawn
 * interleaved (left line, right line, left line…), so a converter that
 * follows the content stream reads across the columns. Paragraph breaks of
 * both columns line up, and the left column is longer than the right one.
 * The text is written for this fixture (no third-party content).
 */
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";

const TITLE = "Reading Order in Two Columns";
const LEFT = [
  "Printed documents often set their text in two or more columns. A reader moves down the first column to its end and only then continues at the top of the next one.",
  "Software that extracts text has to recover that order from positions alone, because the file itself may store the lines in any sequence it likes.",
  "When the breaks between paragraphs happen to line up across columns, a naive algorithm cuts the page into rows and then reads every row from left to right.",
  "The left column of this page is deliberately longer than the right one, so its last paragraph sits alone at the bottom of the body.",
];
const RIGHT = [
  "Columns are separated by a gutter, a narrow vertical band without any text. Finding that band through the whole body reveals how the page is divided.",
  "Headings and footers usually span the full width and interrupt the columns, so the page has to be split into rows before the columns can be found.",
  "Merging rows that share the same gutter restores the columns again, and each column can then be read from top to bottom without interruption.",
];
const FOOTER =
  "This footer spans both columns and must be read last, after the final paragraph of the left column.";

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function buildColumnsPdf(): Promise<{ pdf: Uint8Array; truth: string }> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const page = pdf.addPage([595, 842]);
  const size = 11;
  const leading = 14;
  const colWidth = 235;
  const leftX = 50;
  const rightX = 310;

  page.drawText(TITLE, { x: leftX, y: 780, size: 20, font: bold });

  // Paragraph i of both columns starts on the same row and both are padded to
  // the taller one, so the breaks between paragraphs line up across columns.
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < LEFT.length; i++) {
    const l = wrap(LEFT[i], font, size, colWidth);
    const r = RIGHT[i] ? wrap(RIGHT[i], font, size, colWidth) : [];
    const height = Math.max(l.length, r.length);
    for (let k = 0; k < height; k++) {
      left.push(l[k] ?? "");
      right.push(r[k] ?? "");
    }
    left.push("");
    right.push("");
  }
  const top = 740;
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    const y = top - i * leading;
    if (left[i]) page.drawText(left[i], { x: leftX, y, size, font });
    if (right[i]) page.drawText(right[i], { x: rightX, y, size, font });
  }
  const footerY = top - rows * leading - 24;
  wrap(FOOTER, font, size, 495).forEach((l, i) => {
    page.drawText(l, { x: leftX, y: footerY - i * leading, size, font });
  });

  const truth = [TITLE, ...LEFT, ...RIGHT, FOOTER].join("\n");
  return { pdf: await pdf.save(), truth };
}
