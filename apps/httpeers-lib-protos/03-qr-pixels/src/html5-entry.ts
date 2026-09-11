/**
 * The in-page half of the incumbent comparison: `Html5Qrcode.scanFileV2`,
 * called the way `src/browser/qr-decode.ts`'s `scanInvitation` calls it —
 * a detached element as the host, `verbose: false`, and `showImage: false`.
 */
import { Html5Qrcode } from "html5-qrcode";

async function scanFile(file: File): Promise<string | null> {
  const host = document.createElement("div");
  host.id = `qr-probe-${Math.random().toString(36).slice(2)}`;
  host.style.display = "none";
  document.body.appendChild(host);
  const scanner = new Html5Qrcode(host.id, { verbose: false });
  try {
    const result = await scanner.scanFileV2(file, /* showImage */ false);
    return result.decodedText;
  } catch {
    return null;
  } finally {
    try {
      await scanner.clear();
    } catch {
      // The scanner complains if it was never started; nothing to clean up.
    }
    host.remove();
  }
}

export { scanFile };
