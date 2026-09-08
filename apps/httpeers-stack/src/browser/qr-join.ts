/**
 * The "scan a picture to join" controls, shared by every page that has a join
 * form.
 *
 * TWO INPUTS, NOT ONE, and for the same reason `../pages/image-peer/` uses two
 * for the gallery: `accept="image/*"` alone lets a phone offer the camera OR
 * the photo library, while adding `capture="environment"` goes straight to the
 * rear camera but REMOVES the ability to pick an existing picture on many
 * browsers. Either control alone loses half the feature, so there are two.
 *
 * It fills the invitation field and submits, rather than joining behind the
 * form's back: the code lands where the user can see it, so a scan that read
 * the wrong QR is visible as a wrong-looking code instead of an unexplained
 * failure to join.
 */
import { scanInvitation } from "./qr-decode.js";

export interface QrJoinInit {
  /** The two file inputs, already in the document. */
  inputs: HTMLInputElement[];
  /** Where a decoded code is written -- the same field a person types into. */
  field: HTMLInputElement;
  /** Called once a code has been placed in `field`. Normally submits the form. */
  onCode: () => void;
  /** Renders progress and failures. */
  status: (message: string) => void;
}

export function wireQrJoin(init: QrJoinInit): void {
  for (const input of init.inputs) {
    input.addEventListener("change", () => {
      void (async () => {
        const file = input.files?.[0];
        // Reset immediately, so picking the SAME file again still fires
        // `change` -- a second attempt at a marginal photo is the common case.
        input.value = "";
        if (file == null) return;

        init.status("Reading the picture…");
        const scan = await scanInvitation(file);

        if (scan.ok) {
          init.field.value = scan.code;
          init.status("Found an invitation in that picture — joining…");
          init.onCode();
          return;
        }

        // The two failures need different things from the user, so they are
        // never collapsed into one message.
        init.status(
          scan.reason === "no-qr"
            ? "No QR code found in that picture. Fill the frame with the code, avoid glare, and try again."
            : `That QR code is not an invitation — it reads “${scan.text.slice(0, 60)}”. Photograph the code on the hub page.`,
        );
      })();
    });
  }
}
