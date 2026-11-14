/**
 * Builds a test page with three kinds of images, each carrying a line of
 * text: a JPEG (its bytes should be kept as is), a PNG with an alpha channel
 * (stored as an image with a soft mask), and a 1-bit stencil mask (an
 * /ImageMask drawn in the fill colour). Pictures are drawn with a browser
 * canvas; the text is written for this fixture.
 */
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
} from "pdf-lib";
import { chromium } from "playwright";

type Pictures = {
  jpeg: number[];
  png: number[];
  mask: { width: number; height: number; bits: number[] };
};

async function drawPictures(): Promise<Pictures> {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    // Source text, not a function: tsx would inject helpers the page lacks.
    return (await page.evaluate(`(async () => {
      const bytes = async (canvas, type) =>
        Array.from(new Uint8Array(await (await canvas.convertToBlob({ type, quality: 0.9 })).arrayBuffer()));

      const photo = new OffscreenCanvas(900, 300);
      let ctx = photo.getContext("2d");
      const g = ctx.createLinearGradient(0, 0, 900, 300);
      g.addColorStop(0, "#f6e7c1");
      g.addColorStop(1, "#c9e2f0");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 900, 300);
      ctx.fillStyle = "#111";
      ctx.font = "56px serif";
      ctx.fillText("Original JPEG photo", 60, 170);

      const label = new OffscreenCanvas(900, 200);
      ctx = label.getContext("2d");
      ctx.fillStyle = "#1a1a1a";
      ctx.font = "56px sans-serif";
      ctx.fillText("Transparent label text", 40, 120);

      const stencil = new OffscreenCanvas(900, 200);
      ctx = stencil.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 900, 200);
      ctx.fillStyle = "#000";
      ctx.font = "56px serif";
      ctx.fillText("Stencil mask scan", 40, 120);
      const px = ctx.getImageData(0, 0, 900, 200).data;
      // 1 bit per pixel, rows padded to bytes; ink is 0 (painted with the default /Decode).
      const rowBytes = Math.ceil(900 / 8);
      const bits = new Array(rowBytes * 200).fill(255);
      for (let y = 0; y < 200; y++)
        for (let x = 0; x < 900; x++)
          if (px[(y * 900 + x) * 4] < 128) bits[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));

      return {
        jpeg: await bytes(photo, "image/jpeg"),
        png: await bytes(label, "image/png"),
        mask: { width: 900, height: 200, bits },
      };
    })()`)) as Pictures;
  } finally {
    await browser.close();
  }
}

export async function buildImagesPdf(): Promise<Uint8Array> {
  const pictures = await drawPictures();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);

  const jpeg = await pdf.embedJpg(Uint8Array.from(pictures.jpeg));
  page.drawImage(jpeg, { x: 50, y: 600, width: 450, height: 150 });

  const png = await pdf.embedPng(Uint8Array.from(pictures.png));
  page.drawImage(png, { x: 50, y: 450, width: 450, height: 100 });

  const { width, height, bits } = pictures.mask;
  const stream = pdf.context.flateStream(Uint8Array.from(bits), {
    Type: "XObject",
    Subtype: "Image",
    Width: width,
    Height: height,
    ImageMask: true,
    BitsPerComponent: 1,
  });
  const ref = pdf.context.register(stream);
  const name = page.node.newXObject("Mask", ref);
  page.pushOperators(
    pushGraphicsState(),
    setFillingRgbColor(0, 0, 0),
    concatTransformationMatrix(450, 0, 0, 100, 50, 300),
    drawObject(name),
    popGraphicsState(),
  );
  return pdf.save();
}
