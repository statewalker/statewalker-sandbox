/**
 * Reading an invitation out of a QR code -- from a live camera, or from a
 * picture already on the device.
 *
 * WHY html5-qrcode AND NOT jsQR. The first version decoded a still photo with
 * jsQR, and it did not work on real photographs: a screenshot decoded fine, a
 * photo of the same screen did not. A still frame gets exactly one attempt, and
 * that attempt has to survive whatever angle, blur, glare and white balance the
 * phone happened to produce. html5-qrcode carries a better-tuned pipeline (and
 * will use the platform's own `BarcodeDetector` where it exists) and, more
 * importantly, gives us the LIVE camera -- which is a different proposition
 * entirely: dozens of frames a second, each one a fresh attempt, while the
 * person watches the preview and adjusts. Aiming feedback is what makes
 * scanning reliable, and a file picker cannot offer it.
 *
 * The file path is kept, because a code can arrive as a screenshot someone
 * sent, and because a camera can be refused or absent.
 *
 * NO DOWNSCALING HERE ANY MORE. The old code shrank photos to 1600px before
 * decoding; measurement showed that was not what broke real photos (a QR
 * survives to about 4 device pixels per module, and the downscale stayed above
 * that), so the resize was doing nothing but cost fidelity. The library sizes
 * its own work.
 */
import { Html5Qrcode } from "html5-qrcode";

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

/** A detached element for the library to work in when scanning a file -- it renders nothing we show. */
function scratchHost(): HTMLElement {
  const host = document.createElement("div");
  host.id = `qr-scan-${Math.random().toString(36).slice(2)}`;
  host.hidden = true;
  document.body.append(host);
  return host;
}

/** Find an invitation in an image file. Never throws: every failure is a reason the caller can render. */
export async function scanInvitation(file: File): Promise<QrScan> {
  const host = scratchHost();
  const reader = new Html5Qrcode(host.id, { verbose: false });
  try {
    // `showImage: false` -- the library would otherwise paint the picture into
    // our hidden host, which costs a full-size decode of a phone photo for
    // something nobody sees.
    const result = await reader.scanFileV2(file, false);
    const text = result.decodedText;
    const code = invitationFromQrText(text);
    return code != null ? { ok: true, code } : { ok: false, reason: "not-an-invitation", text };
  } catch {
    // The library rejects when it finds nothing; it does not distinguish
    // "no code" from "unreadable", and neither can the person holding the
    // phone -- both mean try again with a better view.
    return { ok: false, reason: "no-qr" };
  } finally {
    try {
      reader.clear();
    } catch {
      /* nothing rendered, nothing to clear */
    }
    host.remove();
  }
}

export interface CameraScan {
  /** Stop the camera and release the track. Safe to call twice. */
  stop: () => Promise<void>;
}

/**
 * Scan continuously from the rear camera into `host`, calling `onCode` with the
 * first invitation seen and stopping itself.
 *
 * Rejects if the camera cannot be started at all -- refused permission, no
 * camera, or an insecure origin -- which the caller renders, because those are
 * the cases where the file picker is the way through.
 */
export async function scanFromCamera(
  host: HTMLElement,
  onCode: (code: string) => void,
): Promise<CameraScan> {
  const reader = new Html5Qrcode(host.id, { verbose: false });
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      if (reader.isScanning) await reader.stop();
      reader.clear();
    } catch {
      /* already torn down */
    }
  };

  await reader.start(
    // `facingMode: environment` asks for the rear camera by constraint rather
    // than by device id, so it works without first enumerating devices --
    // which on some browsers needs permission of its own.
    { facingMode: "environment" },
    {
      fps: 10,
      // NO `qrbox`. It is a CROP, not a decoration: html5-qrcode only decodes
      // what falls inside it, and it is measured against the rendered
      // viewfinder rather than the camera's own resolution. Both a fixed
      // 260x260 box and a box computed from the 320px preview cut a QR that
      // fills the frame -- which is exactly what a person does when told to
      // point the camera at a code. Verified: a 1280x720 frame whose QR was
      // decodable by the file path scanned as nothing in the live path until
      // this was removed.
      //
      // Scanning the whole frame costs a little more work per frame, on a
      // task that runs for a few seconds once.
      aspectRatio: undefined,
    },
    (text) => {
      const code = invitationFromQrText(text);
      // A QR that is not an invitation must NOT stop the scan: the camera is
      // very likely still pointed at a poster or a wifi sticker, and giving up
      // on the first wrong code would be worse than carrying on looking.
      if (code == null) return;
      void stop().then(() => onCode(code));
    },
    // Per-frame misses are the normal state of a live scanner, not errors.
    () => {},
  );

  return { stop };
}
