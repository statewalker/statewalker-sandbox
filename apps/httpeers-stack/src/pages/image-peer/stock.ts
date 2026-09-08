/**
 * Pictures pulled from a public image stock, so this peer serves bytes it
 * fetched from the open web rather than only what was bundled with it.
 *
 * WHY THIS MATTERS FOR THE DEMO. A peer that serves its own build artefacts
 * proves routing. A peer that serves something it went and got, to another peer
 * that could have gone and got it itself but asks this one instead, is the
 * actual claim: the mesh moves bytes between participants, and a participant is
 * whatever holds the bytes.
 *
 * SAME SHAPE AS `fixtures.ts` ON PURPOSE. `loadStockImages` returns the same
 * `{ initialFiles, images }` pair `loadFixtureImages` does, so `main.ts` treats
 * a bundled fixture and a freshly fetched photograph identically and neither
 * source is privileged.
 *
 * FAILURE IS PARTIAL, NEVER TOTAL. A stock that rate-limits, 500s or serves an
 * HTML error page for one request must not cost the whole gallery; and if every
 * request fails this returns an empty set rather than throwing, so the caller
 * can fall back to the bundled fixtures instead of the page dying. A peer
 * advertising an image service with nothing behind it is worse than a peer
 * serving four familiar pictures.
 */
import type { ImageInfo } from "../../services/images.js";
import { imagePath } from "../../services/images.js";

/** How many pictures a fresh page pulls. Small: each one is a network round trip before the gallery renders. */
export const STOCK_IMAGE_COUNT = 4;

/** Lorem Picsum. Chosen because it answers cross-origin requests with `access-control-allow-origin: *` on both the redirect and the CDN it redirects to -- verified, not assumed. Without that the bytes are unreadable to script and cannot be re-served. */
const STOCK_BASE = "https://picsum.photos/seed";

/** Wide enough to look like a photograph, small enough that four of them are a fast page load and a cheap mesh transfer. */
const WIDTH = 600;
const HEIGHT = 400;

export interface LoadStockImagesInit {
  /** Injected so tests exercise the real code path without a network. */
  fetch?: typeof globalThis.fetch;
  count?: number;
}

export interface LoadedStockImages {
  /** Keyed exactly as `imagePath(id)` expects -- ready for `new MemFilesApi({ initialFiles })`. */
  initialFiles: Record<string, Uint8Array>;
  images: ImageInfo[];
}

/** A seed nobody else is using this second, so a reload asks the stock for a different picture. */
function freshSeed(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadStockImages(init: LoadStockImagesInit = {}): Promise<LoadedStockImages> {
  const doFetch = init.fetch ?? globalThis.fetch;
  const count = init.count ?? STOCK_IMAGE_COUNT;

  const settled = await Promise.allSettled(
    Array.from({ length: count }, async (): Promise<{ info: ImageInfo; bytes: Uint8Array }> => {
      const seed = freshSeed();
      const res = await doFetch(`${STOCK_BASE}/${seed}/${WIDTH}/${HEIGHT}`);
      if (!res.ok) throw new Error(`stock image ${seed}: HTTP ${res.status}`);

      // A stock under load answers with an HTML error page and status 200.
      // Serving that as `image/jpeg` would put a broken picture in every peer's
      // gallery, with nothing anywhere saying why.
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        throw new Error(`stock image ${seed}: expected an image, got "${contentType}"`);
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        info: {
          id: `stock-${seed}`,
          title: `From an image stock (${WIDTH}x${HEIGHT})`,
          contentType,
          size: bytes.length,
        },
        bytes,
      };
    }),
  );

  const initialFiles: Record<string, Uint8Array> = {};
  const images: ImageInfo[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") {
      console.warn("image-peer: a stock image did not load:", outcome.reason);
      continue;
    }
    initialFiles[imagePath(outcome.value.info.id)] = outcome.value.bytes;
    images.push(outcome.value.info);
  }
  return { initialFiles, images };
}
