/**
 * The scan controls' markup, built once and shared.
 *
 * These lived as a copied block in every joining page's `index.html`, which is
 * how two pages drift apart: a fix to the wording or the ids lands in one and
 * not the other. The elements are created here instead, so `qr-join.ts` and
 * this file are the whole feature and a page only says WHERE it goes.
 */
export interface QrJoinElements {
  fileInput: HTMLInputElement;
  cameraButton: HTMLButtonElement;
  cameraHost: HTMLElement;
  status: HTMLElement;
}

/** Build the controls and append them to `parent` (normally the join form). */
export function createQrJoinUi(parent: HTMLElement): QrJoinElements {
  const row = document.createElement("p");
  row.className = "scan";

  const label = document.createElement("span");
  label.textContent = "scan the invitation:";

  const cameraButton = document.createElement("button");
  cameraButton.type = "button";
  cameraButton.id = "scan-camera";
  cameraButton.textContent = "scan with camera";

  const picker = document.createElement("label");
  picker.className = "picker";
  picker.append("scan image");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.id = "scan-file";
  fileInput.accept = "image/*";
  picker.append(fileInput);

  row.append(label, cameraButton, picker);

  // The scanner addresses its mount BY ID, so this element must carry one.
  const cameraHost = document.createElement("div");
  cameraHost.id = "scan-camera-host";
  cameraHost.hidden = true;

  const status = document.createElement("p");
  status.id = "scan-status";

  parent.append(row, cameraHost, status);
  return { fileInput, cameraButton, cameraHost, status };
}
