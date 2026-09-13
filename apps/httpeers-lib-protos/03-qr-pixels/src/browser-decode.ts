/**
 * Run the INCUMBENT decoder — `html5-qrcode`, exactly as
 * `src/browser/qr-decode.ts` uses it — over the same images, in a real
 * Chromium.
 *
 * `scanFileV2(File)` is the entry point `scanInvitation` calls, so this is the
 * shipping path and not a lower-level API chosen to flatter it. The images are
 * handed over as data URLs and rebuilt into `File`s in the page, because that
 * is what a file picker would have produced.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export interface DecodeInput {
  name: string;
  png: Buffer;
}

/** `name -> decoded text`, absent where the decoder found nothing. */
export async function decodeInChromium(inputs: DecodeInput[]): Promise<Record<string, string>> {
  const built = await build({
    root: here,
    logLevel: "error",
    build: {
      target: "esnext",
      write: false,
      lib: { entry: resolve(here, "html5-entry.ts"), formats: ["iife"], name: "QrProbe" },
    },
  });
  // `build()` returns one result or an array of them depending on how many
  // outputs the config asks for, and neither shape is narrowed by its type.
  // biome-ignore lint/suspicious/noExplicitAny: the union is not narrowable here.
  const results = (Array.isArray(built) ? built : [built]) as any[];
  const chunk = results[0]?.output?.find((o: { type: string }) => o.type === "chunk");
  if (chunk == null) throw new Error("decodeInChromium: vite produced no chunk to inject");
  const bundle: string = chunk.code;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // A page is needed only because html5-qrcode reaches for `document`; the
    // origin is irrelevant, so a blank about:blank-equivalent page will do.
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: bundle });

    const payloads = inputs.map((i) => ({
      name: i.name,
      dataUrl: `data:image/png;base64,${i.png.toString("base64")}`,
    }));

    return await page.evaluate(async (items) => {
      const out: Record<string, string> = {};
      for (const item of items) {
        try {
          const blob = await (await fetch(item.dataUrl)).blob();
          const file = new File([blob], `${item.name}.png`, { type: blob.type || "image/png" });
          const text = await (
            window as unknown as { QrProbe: { scanFile(f: File): Promise<string> } }
          ).QrProbe.scanFile(file);
          if (text != null) out[item.name] = text;
        } catch {
          // A decoder that finds nothing throws; that is a miss, not an error.
        }
      }
      return out;
    }, payloads);
  } finally {
    await browser.close();
  }
}
