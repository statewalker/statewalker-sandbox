/**
 * A picture the person chose or just took, turned into something this peer can
 * serve to the mesh.
 *
 * WHY DOWNSCALING IS NOT A NICETY. A phone camera produces several megabytes.
 * The deployed relay applies a 1 MiB per-connection data limit (see the relay's
 * `limits.ts`, where that number is argued: a circuit carries WebRTC signalling
 * and then gets out of the way). Browser peers normally upgrade to WebRTC and
 * an unlimited connection, so a large photo is usually fine -- but a peer whose
 * upgrade fails falls back to the circuit, and there the transfer is cut off
 * part-way. The receiving gallery then shows a half-drawn image with nothing
 * anywhere explaining it. Serving something bounded avoids depending on an
 * upgrade that "usually" happens.
 *
 * Downscaling needs a canvas, so it only runs in a browser. Where there is no
 * `createImageBitmap` -- a test, a Node harness -- the original bytes are used
 * unchanged, because the alternative is this module being untestable off a
 * page.
 */
import type { ImageInfo } from "../../services/images.js";
import { imagePath } from "../../services/images.js";

/** Longest edge served. A photo above this is re-encoded; see the module comment for why bounded matters more than sharp. */
export const MAX_IMAGE_DIMENSION = 1280;

/** What a picture becomes when the browser reports no type at all -- some Android pickers do. */
const FALLBACK_CONTENT_TYPE = "image/jpeg";

export interface LocalImage {
  info: ImageInfo;
  bytes: Uint8Array;
  /** Where to write `bytes` so `createImagesEndpoint` finds them. */
  path: string;
}

/** Distinct per pick, so choosing the same file twice yields two gallery entries rather than one silently replacing the other. */
function freshId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Re-encode to at most `MAX_IMAGE_DIMENSION` on the longest edge. Returns the
 * input untouched when it is already small enough, or when this runtime has no
 * canvas to do it with.
 */
async function downscale(file: File, contentType: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const original = new Uint8Array(await file.arrayBuffer());
  const canDecode = typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";
  if (!canDecode) return { bytes: original, contentType };

  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= MAX_IMAGE_DIMENSION) {
      bitmap.close();
      return { bytes: original, contentType };
    }
    const scale = MAX_IMAGE_DIMENSION / longest;
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      bitmap.close();
      return { bytes: original, contentType };
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), contentType: "image/jpeg" };
  } catch (err) {
    // A picture that cannot be decoded here is still worth serving as-is: the
    // receiving browser may well manage it.
    console.warn("image-peer: could not downscale, serving the original:", err);
    return { bytes: original, contentType };
  }
}

export async function fileToImage(file: File): Promise<LocalImage> {
  const declared = file.type;
  if (declared !== "" && !declared.startsWith("image/")) {
    throw new Error(`"${file.name}" is not an image (${declared}) -- refusing to serve it as one.`);
  }
  const contentType = declared === "" ? FALLBACK_CONTENT_TYPE : declared;

  const scaled = await downscale(file, contentType);
  const id = freshId();
  return {
    info: {
      id,
      title: file.name.replace(/\.[^.]+$/, "") || "Untitled",
      contentType: scaled.contentType,
      size: scaled.bytes.length,
    },
    bytes: scaled.bytes,
    path: imagePath(id),
  };
}
