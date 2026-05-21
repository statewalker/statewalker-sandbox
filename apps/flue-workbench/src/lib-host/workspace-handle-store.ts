import { type BrowserFilesApi, openBrowserFilesApi } from "@statewalker/webrun-files-browser";
import { del, get, set } from "idb-keyval";

const HANDLE_KEY = "flue-workbench:root-dir";

/**
 * Picker-or-resume flow:
 *
 * - On first boot the user clicks "Pick workspace" → `showDirectoryPicker()`
 *   resolves, the handle is stored in IndexedDB at `flue-workbench:root-dir`.
 * - On reload, `openBrowserFilesApi` reads the cached handle and re-requests
 *   permission. If granted, the same workspace re-opens without a picker.
 *
 * The host owns this flow (not the library): permission UI is app-shaped,
 * not library-shaped.
 *
 * Throws `DOMException` with `name: "AbortError"` if the user cancels the
 * picker; throws a generic Error if the cached handle is no longer
 * accessible.
 */
export async function openOrResumeWorkspace(): Promise<{
  files: BrowserFilesApi;
  workspaceKey: string;
}> {
  const files = await openBrowserFilesApi({
    handlerKey: HANDLE_KEY,
    readwrite: true,
    get: (key) => get<FileSystemDirectoryHandle>(key),
    set: (key, handle) => set(key, handle),
    del: (key) => del(key),
  });

  // The workspace key needs to stay stable across reloads of the same
  // directory. We derive it from the picked directory name — good enough
  // for v1 since a user normally picks distinct directories per workspace.
  // If they ever pick two folders with identical names, they'll share a
  // session id; that's a v2 concern.
  const cached = await get<FileSystemDirectoryHandle>(HANDLE_KEY);
  const workspaceKey = cached?.name ?? "workspace";

  return { files, workspaceKey };
}

/** Forget the cached handle (e.g. user clicked "Switch workspace"). */
export async function forgetWorkspace(): Promise<void> {
  await del(HANDLE_KEY);
}
