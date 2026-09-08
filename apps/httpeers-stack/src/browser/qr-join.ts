/**
 * The "scan a QR to join" controls, shared by every page that has a join form.
 *
 * TWO WAYS IN, AND THEY ARE NOT EQUIVALENT. The camera is the one that works:
 * it takes dozens of attempts a second while the person watches the preview and
 * adjusts, and that aiming feedback is what makes scanning reliable. A picture
 * gets exactly one attempt at whatever angle and glare the phone captured --
 * which is why the first version of this feature, still-photo only, failed on
 * real photographs. The picker stays for the cases the camera cannot serve: a
 * screenshot somebody sent, a refused permission, a device with no camera.
 *
 * Either way the decoded code lands in the invitation FIELD and the form is
 * submitted, rather than joining behind the form's back -- so a scan that read
 * the wrong QR shows up as a wrong-looking code instead of an unexplained
 * failure to join.
 */
import { type CameraScan, scanFromCamera, scanInvitation } from "./qr-decode.js";

export interface QrJoinInit {
  /** File inputs for the picture path. */
  fileInputs: HTMLInputElement[];
  /** Starts and stops the live camera. */
  cameraButton: HTMLButtonElement;
  /** Where the camera preview is mounted. Must carry an id -- the scanner addresses it by id. */
  cameraHost: HTMLElement;
  /** Where a decoded code is written -- the same field a person types into. */
  field: HTMLInputElement;
  /** Called once a code has been placed in `field`. Normally submits the form. */
  onCode: () => void;
  /** Renders progress and failures. */
  status: (message: string) => void;
}

export function wireQrJoin(init: QrJoinInit): void {
  let session: CameraScan | null = null;

  const closeCamera = async (): Promise<void> => {
    await session?.stop();
    session = null;
    init.cameraHost.hidden = true;
    init.cameraButton.textContent = "scan with camera";
  };

  const accept = (code: string): void => {
    init.field.value = code;
    init.status("Found an invitation — joining…");
    init.onCode();
  };

  init.cameraButton.addEventListener("click", () => {
    void (async () => {
      if (session != null) {
        await closeCamera();
        init.status("");
        return;
      }
      init.cameraHost.hidden = false;
      init.cameraButton.textContent = "stop camera";
      init.status("Point the camera at the QR code on the hub page…");
      try {
        session = await scanFromCamera(init.cameraHost, (code) => {
          void closeCamera().then(() => accept(code));
        });
      } catch (err) {
        await closeCamera();
        // Naming the cause matters: a refused permission is fixed in browser
        // settings, no camera is fixed by using the picker instead, and those
        // are not the same instruction.
        init.status(
          `Could not start the camera (${err instanceof Error ? err.message : String(err)}). ` +
            "Use “scan image” with a photo or screenshot instead.",
        );
      }
    })();
  });

  for (const input of init.fileInputs) {
    input.addEventListener("change", () => {
      void (async () => {
        const file = input.files?.[0];
        // Reset immediately, so picking the SAME file again still fires
        // `change` -- a second attempt at a marginal photo is the common case.
        input.value = "";
        if (file == null) return;
        await closeCamera();

        init.status("Reading the picture…");
        const scan = await scanInvitation(file);
        if (scan.ok) {
          accept(scan.code);
          return;
        }
        // The two failures need different things from the user, so they are
        // never collapsed into one message.
        init.status(
          scan.reason === "no-qr"
            ? "No QR code found in that picture. The camera works far better than a photo — try “scan with camera”."
            : `That QR code is not an invitation — it reads “${scan.text.slice(0, 60)}”.`,
        );
      })();
    });
  }
}
