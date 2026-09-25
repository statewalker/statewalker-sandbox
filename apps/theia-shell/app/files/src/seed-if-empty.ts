import { type FilesApi, writeText } from "@statewalker/webrun-files";

/** Seed content: text is written as UTF-8, bytes as they are. */
export type Seed = Record<string, string | Uint8Array>;

/**
 * Writes `seed` into `files` if its root is empty, so a first visit shows
 * something while later visits keep the user's own files.
 * Returns whether it seeded.
 */
export async function seedIfEmpty(files: FilesApi, seed: Seed): Promise<boolean> {
  for await (const _ of files.list("/")) return false;
  for (const [path, content] of Object.entries(seed)) {
    if (typeof content === "string") await writeText(files, path, content);
    else await files.write(path, [content]);
  }
  return true;
}
