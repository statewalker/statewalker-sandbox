import { strToU8, type Zippable, zipSync } from "fflate";
import type { PdfPortableTextDocument } from "./schema.ts";

/** ZIP with `document.json` and the binary images under the paths named by each asset. */
export async function createBundle(
  doc: PdfPortableTextDocument,
  blobs: Map<string, Blob>,
): Promise<Blob> {
  const files: Zippable = {
    "document.json": [strToU8(JSON.stringify(doc, null, 2)), { level: 6 }],
  };
  for (const [id, asset] of Object.entries(doc.assets)) {
    const blob = blobs.get(id);
    if (blob) files[asset.path] = new Uint8Array(await blob.arrayBuffer());
  }
  // Images are already compressed: store them as is, deflate only the JSON.
  const zipped = zipSync(files, { level: 0 });
  return new Blob([zipped as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
