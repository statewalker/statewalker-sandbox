// Image placement and text visibility from pdf.js operator lists, on PDFs built with pdf-lib.
import { PDFDocument, PDFName, type PDFRef } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { createRunClassifier, scanImagePlacements } from "../src/pdf-scan.ts";

/** A 600×800 page whose content and XObjects `build` sets up; the image is 32×32 gray. */
async function pageWith(
  build: (
    ctx: PDFDocument["context"],
    page: ReturnType<PDFDocument["addPage"]>,
    image: PDFRef,
  ) => void,
) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const ctx = doc.context;
  const image = ctx.register(
    ctx.stream(new Uint8Array(32 * 32).fill(128), {
      Type: "XObject",
      Subtype: "Image",
      Width: 32,
      Height: 32,
      ColorSpace: "DeviceGray",
      BitsPerComponent: 8,
    }),
  );
  build(ctx, page, image);
  const pdf = await getDocument({ data: await doc.save(), verbosity: 0 }).promise;
  return { pdf, page: await pdf.getPage(1) };
}

describe("scanImagePlacements", () => {
  it("applies a form XObject's /Matrix (a Float32Array in pdf.js 6)", async () => {
    const { pdf, page } = await pageWith((ctx, p, image) => {
      const form = ctx.register(
        ctx.stream("q 100 0 0 100 0 0 cm /Im0 Do Q", {
          Type: "XObject",
          Subtype: "Form",
          BBox: [0, 0, 100, 100],
          Matrix: [1, 0, 0, 1, 300, 400],
          Resources: { XObject: { Im0: image } },
        }),
      );
      p.node.setXObject(PDFName.of("Fm0"), form as never);
      p.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("q /Fm0 Do Q")));
    });
    const [placement] = await scanImagePlacements(page);
    expect(placement.bbox).toMatchObject({ x: 300, y: 300, width: 100, height: 100 });
    await pdf.loadingTask.destroy();
  });

  it("places an annotation's appearance at the annotation's rectangle", async () => {
    const { pdf, page } = await pageWith((ctx, p, image) => {
      const appearance = ctx.register(
        ctx.stream("q 100 0 0 50 0 0 cm /Im0 Do Q", {
          Type: "XObject",
          Subtype: "Form",
          BBox: [0, 0, 100, 50],
          Resources: { XObject: { Im0: image } },
        }),
      );
      const annot = ctx.register(
        ctx.obj({
          Type: "Annot",
          Subtype: "Stamp",
          Rect: [400, 50, 500, 100],
          AP: { N: appearance },
        }),
      );
      p.node.set(PDFName.of("Annots"), ctx.obj([annot]));
      p.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("")));
    });
    const [placement] = await scanImagePlacements(page);
    expect(placement.bbox).toMatchObject({ x: 400, y: 700, width: 100, height: 50 });
    await pdf.loadingTask.destroy();
  });
});

describe("createRunClassifier", () => {
  it("tells a visible word from the same word in an invisible layer, by order", () => {
    const classify = createRunClassifier({
      visible: "themethod",
      invisible: "theresults",
      segments: [
        { text: "themethod", invisible: false },
        { text: "the", invisible: true },
        { text: "results", invisible: true },
      ],
    });
    expect(classify("the method")).toBe(false);
    expect(classify("the")).toBe(true); // the invisible "the", after the visible run
    expect(classify("results")).toBe(true);
  });

  it("matches ligatures: text content is NFKC, glyph unicode is not", () => {
    const classify = createRunClassifier({
      visible: "ﬁnancial",
      invisible: "ﬁnancial",
      segments: [
        { text: "ﬁnancial".normalize("NFKC"), invisible: false },
        { text: "ﬁnancial".normalize("NFKC"), invisible: true },
      ],
    });
    expect(classify("financial")).toBe(false);
    expect(classify("financial")).toBe(true);
  });
});
