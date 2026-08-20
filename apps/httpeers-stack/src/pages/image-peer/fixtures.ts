/**
 * The BROWSER half of "get fixture bytes into a `FilesApi`" -- the other
 * half is `../../services/image-fixtures.node.ts`, used only by
 * `tests/images.test.ts`. See that file's own doc comment for why the two
 * are split: `../../services/images.ts` itself stays isomorphic (no
 * `node:fs`, no `fetch`), so it is this page's job -- not that service
 * module's -- to know how ITS environment gets bytes off of
 * `../../services/image-fixtures/`.
 *
 * `import.meta.glob`, NOT `new URL(dynamic, import.meta.url)`. Vite's
 * "Explicit URL Imports" feature (`new URL('./literal.png', import.meta.url)`)
 * only rewrites a STATIC STRING LITERAL argument -- verified directly, not
 * assumed: an earlier version of this file built `new URL(`./${entry.file}`,
 * import.meta.url)` (the filename read from `manifest.json` at runtime) and
 * a production build silently emitted `dist/image-peer/` with NO fixture
 * assets accounted for at all -- no error, just an origin that 404s every
 * fetch the moment this page tries to load them. `import.meta.glob` is
 * Vite's documented mechanism for exactly this case -- "a set of files
 * matching a pattern, resolved without listing every filename" -- and,
 * unlike the `new URL` form, it does not require the set of files to be
 * known ahead of writing this code, only the glob pattern.
 *
 * WHERE THE BYTES ACTUALLY END UP: verified by reading the built output,
 * not assumed. Every fixture here is well under Vite's default
 * `assetsInlineLimit` (4 KiB), so `query: "?url"` still resolves to a real
 * URL string, but that string is a `data:` URI with the bytes inlined as
 * base64 -- NOT a copied file under `dist/image-peer/`. `fetch()` on a
 * `data:` URL is ordinary, spec-defined Fetch behaviour (confirmed directly
 * under Node's own `fetch`, and it holds in every browser too), so
 * `fetchBytes` below needs no special case for it. A future fixture large
 * enough to cross that threshold would instead get a real copied,
 * hashed file -- `fetchBytes` does not care which; it only ever sees a URL.
 */
import type { ImageInfo } from "../../services/images.js";
import { imagePath } from "../../services/images.js";

interface ManifestEntry {
  id: string;
  title: string;
  file: string;
  contentType: string;
}

export interface LoadedFixtureImages {
  /** Keyed exactly as `imagePath(id)` expects -- ready for `new MemFilesApi({ initialFiles })`. */
  initialFiles: Record<string, Uint8Array>;
  images: ImageInfo[];
}

// Every file directly under `image-fixtures/` (manifest included), eagerly
// resolved to its built, hashed URL -- keyed by the glob-relative path Vite
// assigns (e.g. `../../services/image-fixtures/relay-node.png`), which is
// exactly `../../services/image-fixtures/${filename}` for any filename that
// exists in that directory, so no separate lookup table is needed to go
// from a manifest entry's `file` back to its URL.
const assetUrls = import.meta.glob<string>("../../services/image-fixtures/*", {
  eager: true,
  query: "?url",
  import: "default",
});

function urlFor(filename: string): string {
  const key = `../../services/image-fixtures/${filename}`;
  const url = assetUrls[key];
  if (url == null) {
    throw new Error(
      `fixtures: "${filename}" is not among the globbed image-fixtures/ assets (looked for key "${key}"); ` +
        `available: ${Object.keys(assetUrls).join(", ")}`,
    );
  }
  return url;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fixtures: GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Fetches `manifest.json` and every fixture it names, in parallel. */
export async function loadFixtureImages(): Promise<LoadedFixtureImages> {
  const manifestBytes = await fetchBytes(urlFor("manifest.json"));
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ManifestEntry[];

  const initialFiles: Record<string, Uint8Array> = {};
  const images: ImageInfo[] = [];
  await Promise.all(
    manifest.map(async (entry) => {
      const bytes = await fetchBytes(urlFor(entry.file));
      initialFiles[imagePath(entry.id)] = bytes;
      images.push({
        id: entry.id,
        title: entry.title,
        contentType: entry.contentType,
        size: bytes.length,
      });
    }),
  );

  return { initialFiles, images };
}
