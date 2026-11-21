/**
 * Builds a test page for text formatting: inline bold and italic, a bullet
 * list with a nested level and a wrapped item, a numbered list whose numbers
 * are drawn as separate items (as word processors do with tabs), and a table
 * with a bold header row. The text is written for this fixture.
 */
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts } from "pdf-lib";

export async function buildFormattingPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const page = pdf.addPage([595, 842]);
  const size = 11;

  /** Draws styled pieces one after the other on a line. */
  const line = (p: PDFPage, x: number, y: number, pieces: [string, PDFFont][]) => {
    let cx = x;
    for (const [text, font] of pieces) {
      p.drawText(text, { x: cx, y, size, font });
      cx += font.widthOfTextAtSize(text, size);
    }
  };

  page.drawText("Formatting Test", { x: 50, y: 780, size: 20, font: bold });
  line(page, 50, 740, [
    ["This sentence has ", regular],
    ["bold words", bold],
    [" and ", regular],
    ["italic words", italic],
    [" in the middle.", regular],
  ]);

  // Bullet list: marker and text in one item; nested item indented.
  let y = 705;
  const bullet = (x: number, marker: string, text: string) => {
    page.drawText(`${marker} ${text}`, { x, y, size, font: regular });
    y -= 16;
  };
  bullet(60, "•", "First bullet item");
  bullet(60, "•", "Second bullet item that is long enough to wrap onto");
  page.drawText("a second, indented line", { x: 69, y, size, font: regular });
  y -= 16;
  bullet(80, "–", "Nested item under the second one");
  bullet(60, "•", "Third bullet item");

  // Numbered list: the number is its own text item, the text starts at a tab stop.
  y -= 14;
  for (const [i, text] of ["Step one", "Step two", "Step three"].entries()) {
    page.drawText(`${i + 1}.`, { x: 60, y, size, font: regular });
    page.drawText(text, { x: 90, y, size, font: regular });
    y -= 16;
  }

  // Table: three columns, bold header.
  y -= 20;
  const cols = [50, 200, 350];
  const rows = [
    ["Country", "Capital", "Population"],
    ["Austria", "Vienna", "8.9 million"],
    ["Belgium", "Brussels", "11.5 million"],
    ["Denmark", "Copenhagen", "5.8 million"],
  ];
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      page.drawText(cell, { x: cols[c], y, size, font: r === 0 ? bold : regular });
    });
    y -= 18;
  });

  y -= 20;
  page.drawText("The end of the formatting test.", { x: 50, y, size, font: regular });
  return pdf.save();
}
