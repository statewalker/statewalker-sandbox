/**
 * Node-only loader for `image-fixtures/` -- reads `manifest.json` and each
 * fixture's actual PNG bytes off disk via `node:fs`, exactly the pattern
 * `search.ts` uses for `search-fixtures.json` (`readFileSync` +
 * `fileURLToPath(new URL(...))`).
 *
 * WHY THIS IS ITS OWN FILE, NOT PART OF `images.ts`. `images.ts` is deployed
 * two ways: bundled into the image peer's own browser page
 * (`../pages/image-peer/main.ts`) AND imported directly by this app's Node
 * test suite. A browser bundler has no `node:fs` to give it, so `images.ts`
 * itself imports neither `node:fs` nor `node:url` -- only a bare `FilesApi`
 * type. This file is the Node-only half of "get bytes into a `FilesApi`";
 * the browser page's own loader (fetching the same fixture files as static
 * assets, see that module's comment) is the other half. Nothing in
 * `src/pages/image-peer/` imports this file.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ImageInfo } from "./images.js";
import { imagePath } from "./images.js";

interface ManifestEntry {
  id: string;
  title: string;
  file: string;
  contentType: string;
}

const manifestPath = fileURLToPath(new URL("./image-fixtures/manifest.json", import.meta.url));
const MANIFEST: ManifestEntry[] = JSON.parse(readFileSync(manifestPath, "utf8"));

export interface LoadedFixtureImages {
  /** Keyed exactly as `imagePath(id)` expects -- ready to hand straight to `new MemFilesApi({ initialFiles })`. */
  initialFiles: Record<string, Uint8Array>;
  images: ImageInfo[];
}

/** Reads every fixture named in `manifest.json` off disk, once per call. */
export function loadFixtureImages(): LoadedFixtureImages {
  const initialFiles: Record<string, Uint8Array> = {};
  const images: ImageInfo[] = [];
  for (const entry of MANIFEST) {
    const buf = readFileSync(
      fileURLToPath(new URL(`./image-fixtures/${entry.file}`, import.meta.url)),
    );
    // A plain `Uint8Array`, not the `Buffer` `readFileSync` actually returns
    // -- `Buffer` IS a `Uint8Array` at runtime, but `MemFilesApi.read` hands
    // BACK a plain `Uint8Array` slice, and a test comparing the two with
    // `toEqual` sees different constructors even when every byte matches.
    // Normalising here keeps this loader's output indistinguishable from
    // `fixtures.ts`'s browser-side loader (`fetch().arrayBuffer()`, which
    // never produces a `Buffer` in the first place).
    const bytes = new Uint8Array(buf);
    initialFiles[imagePath(entry.id)] = bytes;
    images.push({
      id: entry.id,
      title: entry.title,
      contentType: entry.contentType,
      size: bytes.length,
    });
  }
  return { initialFiles, images };
}
