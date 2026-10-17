import { escapeHTML, toHTML } from "@portabletext/to-html";
import type { ImageBlock, OcrBoxMark, PdfPortableTextDocument, TextBlock } from "./schema.ts";

/**
 * Renders the document with @portabletext/to-html. Images get an SVG overlay
 * with the bbox of every word recognised in them; OCR words are wrapped in
 * spans that carry their bbox so the page can highlight it on hover.
 */
export function renderPreview(doc: PdfPortableTextDocument, urls: Map<string, string>): string {
  const wordsByImage = new Map<string, OcrBoxMark[]>();
  for (const block of doc.blocks) {
    if (block._type !== "block") continue;
    for (const mark of block.markDefs) {
      const list = wordsByImage.get(mark.image) ?? [];
      list.push(mark);
      wordsByImage.set(mark.image, list);
    }
  }

  return toHTML(doc.blocks as never, {
    components: {
      types: {
        image: ({ value }: { value: ImageBlock }) => {
          const url = urls.get(value.asset._ref) ?? "";
          const boxes = (wordsByImage.get(value._key) ?? [])
            .map(
              (w) =>
                `<rect data-mark="${w._key}" x="${w.bbox.x}" y="${w.bbox.y}" width="${w.bbox.width}" height="${w.bbox.height}"><title>${(w.confidence * 100).toFixed(0)}%</title></rect>`,
            )
            .join("");
          const caption = [
            `page ${value.source.page}`,
            `${value.width}×${value.height}px`,
            value.source.type === "pageRender" ? "rendered page" : "embedded image",
            value.ocr
              ? `${value.ocr.wordCount} words, ${(value.ocr.confidence * 100).toFixed(0)}% conf.`
              : "",
            value.ocr ? `lang ${value.ocr.language} (${value.ocr.languageSource})` : "",
            value.ocr?.rotation ? `rotated ${value.ocr.rotation}°` : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return `<figure class="pt-image" data-key="${value._key}">
  <div class="pt-image-frame">
    <img src="${url}" width="${value.width}" height="${value.height}" alt="">
    <svg viewBox="0 0 ${value.width} ${value.height}" preserveAspectRatio="none">${boxes}</svg>
  </div>
  <figcaption>${escapeHTML(caption)} · <code>${escapeHTML(value.asset._ref)}</code></figcaption>
</figure>`;
        },
      },
      marks: {
        ocrBox: ({ children, value }: { children: string; value?: OcrBoxMark }) =>
          !value
            ? children
            : `<span class="ocr-word" data-image="${value.image}" data-mark="${value._key}" title="${value.bbox.x},${value.bbox.y} ${value.bbox.width}×${value.bbox.height} · ${(value.confidence * 100).toFixed(0)}%">${children}</span>`,
      },
      block: ({ value: v, children }) => {
        const value = v as unknown as TextBlock;
        const tag = value.style === "normal" ? "p" : value.style;
        const cls = value.source.type === "ocr" ? "pt-block ocr" : "pt-block";
        const lang = value.language ? ` lang="${value.language}"` : "";
        return `<${tag} class="${cls}" data-key="${value._key}"${lang}>${children ?? ""}</${tag}>`;
      },
    },
    onMissingComponent: false,
  });
}
