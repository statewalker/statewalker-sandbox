/**
 * Reading an invitation out of a picture -- one chosen from the photo library,
 * or one just taken of somebody's hub screen.
 *
 * WHY jsQR AND NOT `BarcodeDetector`. The platform API is not available on
 * every browser this has to work on, so using it means a capability branch,
 * and the fallback arm would be the one that almost never runs -- which is
 * exactly where a bug survives unnoticed. One code path everywhere is worth
 * the bytes.
 *
 * WHY THE PHOTO IS DOWNSCALED. jsQR walks every pixel, and a modern phone
 * photo is 4000x3000 -- twelve million pixels to find a 45x45 grid in. Scaling
 * the long edge down first makes it fast without hurting detection, because a
 * QR code that is unreadable at 1600px was not going to decode at 4000px
 * either.
 *
 * This resize is the OPPOSITE of the gallery's rule in `./local-image.ts`,
 * which deliberately serves a photo's bytes untouched. The difference is what
 * happens to the result: there the bytes are what other peers receive, here
 * they are thrown away the moment the code is read. Nothing downscaled by this
 * module is ever stored or served.
 */
import jsQR from "jsqr";

/** Longest edge fed to the decoder. Comfortably above what a QR needs; far below what a phone produces. */
export const QR_DECODE_MAX_DIMENSION = 1600;

/** Shape of a decoded invitation, or the reason there isn't one. */
export type QrScan =
  | { ok: true; code: string }
  /** A QR was found, but it does not carry an invitation -- a wifi code, a URL, a poster. */
  | { ok: false; reason: "not-an-invitation"; text: string }
  /** No QR anywhere in the image: wrong picture, too blurry, too small, glare. */
  | { ok: false; reason: "no-qr" };

/**
 * The invitation inside a decoded QR's text, or `null`.
 *
 * Accepts the bare code the hub mints, and also a `?join=` link -- a phone's
 * native camera hands over whatever the QR held, and a link is the one other
 * form these codes travel in, so refusing it would be a puzzle rather than a
 * safeguard.
 */
export function invitationFromQrText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  if (trimmed.includes("://")) {
    try {
      const join = new URL(trimmed).searchParams.get("join");
      return join != null && looksLikeCode(join) ? join : null;
    } catch {
      return null;
    }
  }
  return looksLikeCode(trimmed) ? trimmed : null;
}

/**
 * A join blob is base64url of a JSON object, so it starts `eyJ` and holds only
 * base64url characters. This is a shape check, not validation: the hub decides
 * whether a code is real, current and unspent. All this does is tell "you
 * scanned the wrong QR" apart from "the hub refused this code", which are
 * different problems with different fixes.
 */
function looksLikeCode(value: string): boolean {
  return value.startsWith("eyJ") && /^[A-Za-z0-9_-]{40,}$/.test(value);
}

/** Draw `bitmap` into a canvas no larger than `QR_DECODE_MAX_DIMENSION` and return its pixels. */
function pixelsOf(bitmap: ImageBitmap): ImageData | null {
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > QR_DECODE_MAX_DIMENSION ? QR_DECODE_MAX_DIMENSION / longest : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (ctx == null) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** Find an invitation in an image file. Never throws: every failure is a reason the caller can render. */
export async function scanInvitation(file: File): Promise<QrScan> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "no-qr" };
  }

  try {
    const pixels = pixelsOf(bitmap);
    if (pixels == null) return { ok: false, reason: "no-qr" };

    // `attemptBoth` also tries inverted colours, which is what a photo of a
    // dark-mode screen produces.
    const found = jsQR(pixels.data, pixels.width, pixels.height, {
      inversionAttempts: "attemptBoth",
    });
    if (found == null) return { ok: false, reason: "no-qr" };

    const code = invitationFromQrText(found.data);
    return code != null ? { ok: true, code } : { ok: false, reason: "not-an-invitation", text: found.data };
  } finally {
    bitmap.close();
  }
}
