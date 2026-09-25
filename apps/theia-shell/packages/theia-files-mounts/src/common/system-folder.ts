import type { FilesApi } from "@statewalker/webrun-files";

/** In the main storage: settings, vault key and secrets. Never shown in the file tree. */
export const SYSTEM_FOLDER = "/.shell";
export const SETTINGS_FOLDER = "/.shell/settings";

export async function hasSystemFolder(files: FilesApi): Promise<boolean> {
  return (await files.stats(SYSTEM_FOLDER))?.kind === "directory";
}

export async function ensureSystemFolder(files: FilesApi): Promise<void> {
  for (const path of [SYSTEM_FOLDER, SETTINGS_FOLDER]) {
    if (!(await files.exists(path))) await files.mkdir(path);
  }
}

/** Copies the system folder (settings, vault) to another storage; the password stays the same. */
export async function copySystemFolder(from: FilesApi, to: FilesApi): Promise<void> {
  await ensureSystemFolder(to);
  for await (const entry of from.list(SYSTEM_FOLDER, { recursive: true })) {
    if (entry.kind === "directory") {
      if (!(await to.exists(entry.path))) await to.mkdir(entry.path);
    } else {
      await to.write(entry.path, from.read(entry.path));
    }
  }
}
