import { NeedsUserGesture } from "./mount-types";

/** The File System Access permission methods (not yet in TypeScript's DOM lib). */
export interface PermissionHandle {
  queryPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
}

/**
 * Read-write access to a stored folder handle. At boot (not interactive) the
 * browser may only be asked from a click, so a "prompt" means NeedsUserGesture.
 */
export async function ensureFolderAccess(
  handle: PermissionHandle,
  interactive: boolean,
  accessible: () => Promise<boolean>,
): Promise<void> {
  let permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted" && interactive)
    permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    if (interactive) throw new Error("Access to the folder was not granted.");
    throw new NeedsUserGesture();
  }
  if (!(await accessible())) throw new Error("The folder is gone (moved or deleted).");
}
