import { type FilesApi, writeText } from "@statewalker/webrun-files";

/**
 * Writes `seed` (path → text) into `files` if its root is empty, so a first
 * visit shows something while later visits keep the user's own files.
 * Returns whether it seeded.
 */
export async function seedIfEmpty(files: FilesApi, seed: Record<string, string>): Promise<boolean> {
  for await (const _ of files.list("/")) return false;
  for (const [path, text] of Object.entries(seed)) await writeText(files, path, text);
  return true;
}
