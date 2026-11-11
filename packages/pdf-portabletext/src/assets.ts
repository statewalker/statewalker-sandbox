import type { ImageAsset } from "./schema.ts";

/**
 * Encoding of image assets. `original` keeps the PDF's own JPEG bytes when an
 * image is stored as a plain JPEG (see `original-images.ts`) and writes PNG
 * otherwise.
 */
export type ImageFormat = "original" | "png" | "jpeg" | "webp";
type EncodedFormat = Exclude<ImageFormat, "original">;

const EXTENSIONS: Record<EncodedFormat, string> = { png: "png", jpeg: "jpg", webp: "webp" };

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
  format: EncodedFormat,
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

/** Asset for a JPEG kept byte for byte from the PDF. */
export async function jpegAsset(
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<StoredAsset> {
  const sha1hash = await sha1Hex(bytes.slice().buffer);
  const id = `image-${sha1hash}-${width}x${height}-jpg`;
  return {
    blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
    meta: {
      _id: id,
      _type: "sanity.imageAsset",
      mimeType: "image/jpeg",
      extension: "jpg",
      size: bytes.length,
      sha1hash,
      path: `assets/${id}.jpg`,
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

/**
 * Image to hand to OCR: scaled, and flattened onto white so transparent areas
 * (soft masks, stencil masks) do not read as black.
 */
export function ocrInput(bitmap: ImageBitmap, scale: number): ImageBitmap {
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.transferToImageBitmap();
}

export async function scaleBitmap(bitmap: ImageBitmap, scale: number): Promise<ImageBitmap> {
  return createImageBitmap(bitmap, {
    resizeWidth: Math.round(bitmap.width * scale),
    resizeHeight: Math.round(bitmap.height * scale),
    resizeQuality: "high",
  });
}
