/**
 * Builds `fixtures/sample-de.pdf`: a German page with a text layer, an
 * embedded PNG of a printed paragraph, and a second page that is only a
 * scanned-looking JPEG, and a third page with vector graphics only. Text images are drawn with a browser canvas
 * (Playwright/Chromium) so no native image tooling is required.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "fixtures", "sample-de.pdf");

async function drawTextImages(): Promise<{ png: Uint8Array; jpeg: Uint8Array }> {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    // Passed as source text: tsx would otherwise inject helpers (`__name`) the page lacks.
    const [png, jpeg] = (await page.evaluate(`(async () => {
      function draw(lines, width, fontPx, type) {
        const lh = Math.round(fontPx * 1.4);
        const canvas = new OffscreenCanvas(width, lines.length * lh + 2 * fontPx);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = type === "image/jpeg" ? "#f4f1ea" : "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#111";
        ctx.font = fontPx + "px serif";
        lines.forEach((line, i) => ctx.fillText(line, fontPx, fontPx + (i + 1) * lh - lh * 0.3));
        return canvas.convertToBlob({ type, quality: 0.92 });
      }
      const toBytes = async (b) => Array.from(new Uint8Array(await b.arrayBuffer()));
      const png = await draw(
        [
          "Rechnung Nr. 2024-117",
          "Sehr geehrte Damen und Herren,",
          "wir bedanken uns für Ihren Auftrag",
          "und berechnen die folgenden Leistungen.",
        ],
        900,
        36,
        "image/png",
      );
      const jpeg = await draw(
        [
          "Kapitel 2: Ergebnisse",
          "",
          "Die Messungen zeigen eine deutliche Verbesserung",
          "gegenüber dem Vorjahr. Die Qualität der Daten",
          "wurde durch zusätzliche Prüfungen gesichert.",
          "",
          "Gesamtsumme: 1.234,56 Euro",
        ],
        1400,
        40,
        "image/jpeg",
      );
      return [await toBytes(png), await toBytes(jpeg)];
    })()`)) as [number[], number[]];
    return { png: Uint8Array.from(png), jpeg: Uint8Array.from(jpeg) };
  } finally {
    await browser.close();
  }
}

const { png, jpeg } = await drawTextImages();
const pdf = await PDFDocument.create();
pdf.setTitle("Beispiel");
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

const page1 = pdf.addPage([595, 842]);
page1.drawText("Beispieldokument", { x: 50, y: 780, size: 24, font: bold });
const body = [
  "Dieses Dokument enthält eine Textebene und ein eingebettetes Bild.",
  "Der Text im Bild wird mit OCR erkannt und als PortableText dargestellt.",
];
for (const [i, line] of body.entries()) {
  page1.drawText(line, { x: 50, y: 740 - i * 14, size: 11, font });
}
const pngImage = await pdf.embedPng(png);
const w = 420;
const h = (pngImage.height / pngImage.width) * w;
page1.drawImage(pngImage, { x: 80, y: 690 - h, width: w, height: h });
page1.drawText("Text unterhalb des Bildes.", {
  x: 50,
  y: 660 - h,
  size: 11,
  font,
  color: rgb(0.2, 0.2, 0.2),
});

const page2 = pdf.addPage([595, 842]);
const jpgImage = await pdf.embedJpg(jpeg);
const w2 = 595;
const h2 = (jpgImage.height / jpgImage.width) * w2;
page2.drawImage(jpgImage, { x: 0, y: 842 - h2, width: w2, height: h2 });

// Page 3 has neither a text layer nor raster images: exercises the page-render fallback.
const page3 = pdf.addPage([595, 842]);
page3.drawRectangle({
  x: 50,
  y: 600,
  width: 300,
  height: 120,
  borderColor: rgb(0, 0, 0),
  borderWidth: 4,
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, await pdf.save());
console.log(`wrote ${out}`);
