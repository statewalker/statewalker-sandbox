import type { ImageAsset } from "./schema.ts";

export type ImageFormat = "png" | "jpeg" | "webp";

const EXTENSIONS: Record<ImageFormat, string> = { png: "png", jpeg: "jpg", webp: "webp" };

export type StoredAsset = { meta: ImageAsset; blob: Blob };

async function sha1Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Encodes a bitmap and describes it as an image asset. The id follows the
 * Sanity convention `image-<sha1>-<width>x<height>-<ext>`, so identical
 * images share one asset.
 */
export async function encodeImageAsset(
  bitmap: ImageBitmap,
  format: ImageFormat,
  quality = 0.9,
): Promise<StoredAsset> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  if (format === "jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  const mimeType = `image/${format}`;
  const blob = await canvas.convertToBlob({ type: mimeType, quality });
  const sha1hash = await sha1Hex(await blob.arrayBuffer());
  const extension = EXTENSIONS[format];
  const { width, height } = bitmap;
  const id = `image-${sha1hash}-${width}x${height}-${extension}`;
  return {
    blob,
    meta: {
      _id: id,
      _type: "sanity.imageAsset",
      mimeType: blob.type || mimeType,
      extension,
      size: blob.size,
      sha1hash,
      path: `assets/${id}.${extension}`,
      metadata: {
        dimensions: { width, height, aspectRatio: Math.round((width / height) * 10000) / 10000 },
      },
    },
  };
}

/**
 * Scale factor for OCR: small images are upscaled towards ~300 dpi text sizes,
 * huge ones (e.g. 2400 dpi scans) downscaled, which is much faster and loses
 * nothing at that resolution.
 */
export function ocrScale(width: number, height: number): number {
  const longSide = Math.max(width, height);
  if (longSide > 4000) return Math.round((4000 / longSide) * 1000) / 1000;
  if (longSide >= 1600) return 1;
  return Math.min(3, Math.max(1, Math.round((1600 / longSide) * 10) / 10));
}

export async function scaleBitmap(bitmap: ImageBitmap, scale: number): Promise<ImageBitmap> {
  return createImageBitmap(bitmap, {
    resizeWidth: Math.round(bitmap.width * scale),
    resizeHeight: Math.round(bitmap.height * scale),
    resizeQuality: "high",
  });
}
