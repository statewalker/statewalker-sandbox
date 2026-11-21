import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { isSafeId } from "./ids.ts";
import type { OutputFiles } from "./types.ts";

const TYPES: Record<string, string> = {
  ".ppm": "image/x-portable-pixmap",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

/**
 * `OutputFiles` over the results folders `<dir>/<jobId>/` (the manager's `outputs.dir`). Only
 * regular files strictly inside the job's folder are served, after resolving symlinks: `..`,
 * absolute paths and links pointing out of it answer `undefined` (404).
 */
export function folderOutputs(dir: string): OutputFiles {
  const root = resolve(dir);
  return {
    async read(id, path) {
      if (!isSafeId(id) || !path) return undefined;
      try {
        const folder = await realpath(resolve(root, id));
        const file = await realpath(resolve(folder, path));
        if (!file.startsWith(folder + sep)) return undefined;
        const info = await stat(file);
        if (!info.isFile()) return undefined;
        return {
          body: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
          size: info.size,
          type: TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        };
      } catch {
        return undefined; // missing folder or file
      }
    },
  };
}
