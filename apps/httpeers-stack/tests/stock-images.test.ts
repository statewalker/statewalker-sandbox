import { describe, expect, it, vi } from "vitest";
import { STOCK_IMAGE_COUNT, loadStockImages } from "../src/pages/image-peer/stock.js";
import { imagePath } from "../src/services/images.js";

function jpeg(bytes = 32): Response {
  return new Response(new Uint8Array(bytes).fill(7), {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  });
}

describe("loadStockImages", () => {
  it("returns bytes keyed exactly as imagePath expects, so MemFilesApi can serve them", async () => {
    const fetchMock = vi.fn(async () => jpeg());
    const { images, initialFiles } = await loadStockImages({ fetch: fetchMock, count: 3 });
    expect(images).toHaveLength(3);
    for (const img of images) {
      expect(initialFiles[imagePath(img.id)]).toBeInstanceOf(Uint8Array);
      expect(img.size).toBe(initialFiles[imagePath(img.id)]?.length);
      expect(img.contentType).toBe("image/jpeg");
    }
  });

  it("asks for a different set every call, so a reload changes the gallery", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (u: string) => {
      urls.push(u);
      return jpeg();
    });
    await loadStockImages({ fetch: fetchMock as never, count: 2 });
    await loadStockImages({ fetch: fetchMock as never, count: 2 });
    expect(new Set(urls).size).toBe(4);
  });

  // One bad image must not cost the whole gallery: a stock that rate-limits or
  // 500s on a single request is common, and losing every picture over it would
  // leave the peer advertising a service with nothing behind it.
  it("keeps the images that did load when one request fails", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      if (n === 2) return new Response("nope", { status: 500 });
      return jpeg();
    });
    const { images } = await loadStockImages({ fetch: fetchMock as never, count: 3 });
    expect(images).toHaveLength(2);
  });

  it("returns nothing rather than throwing when every request fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    const { images, initialFiles } = await loadStockImages({ fetch: fetchMock as never, count: 3 });
    expect(images).toEqual([]);
    expect(Object.keys(initialFiles)).toEqual([]);
  });

  it("rejects a response that is not an image, rather than serving HTML as a picture", async () => {
    const fetchMock = vi.fn(
      async () => new Response("<html>rate limited</html>", { headers: { "content-type": "text/html" } }),
    );
    const { images } = await loadStockImages({ fetch: fetchMock as never, count: 2 });
    expect(images).toEqual([]);
  });

  it("has a sensible default count", () => {
    expect(STOCK_IMAGE_COUNT).toBeGreaterThan(0);
    expect(STOCK_IMAGE_COUNT).toBeLessThanOrEqual(8);
  });
});
