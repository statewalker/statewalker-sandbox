import type { FileRef } from "@fm/app";

/**
 * A private MIME type, so an internal drag never reaches the OS handler.
 *
 * A drag carrying `text/uri-list` or `Files` is something the browser and the
 * desktop will both try to interpret. Ours carries one type nothing else
 * claims, which is what keeps a panel-to-panel move from being handed to the
 * operating system as a download.
 */
export const FM_SELECTION = "application/x-fm-selection";

export interface DragPayload {
  sourcePanelId: string;
  files: FileRef[];
}

export function writeSelection(dataTransfer: DataTransfer, payload: DragPayload): void {
  dataTransfer.setData(FM_SELECTION, JSON.stringify(payload));
  dataTransfer.effectAllowed = "copyMove";
}

export function readSelection(dataTransfer: DataTransfer): DragPayload | undefined {
  if (![...dataTransfer.types].includes(FM_SELECTION)) return undefined;
  const raw = dataTransfer.getData(FM_SELECTION);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return undefined;
  }
}

/** An external drag is one the OS started: it carries files, not our type. */
export function isExternalDrop(dataTransfer: DataTransfer): boolean {
  return !readSelection(dataTransfer) && [...dataTransfer.types].includes("Files");
}
