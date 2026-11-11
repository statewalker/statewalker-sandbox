// The `stream` task: a holder streams a file through CapFilesApi over its capability. It makes
// the chunked transfer observable end to end (and shows how a holder uses it): `write` streams
// `size` deterministic bytes from `seed` in `chunk`-byte pieces, `read` streams a range back;
// both answer with the byte count, the chunk count and the SHA-256 of what passed.

import { CapFilesApi } from "./cap-files-api.ts";
import type { Cap } from "./caps.ts";

export type StreamTask =
  | { op: "write"; path: string; size: number; seed?: number; chunk?: number }
  | { op: "read"; path: string; start?: number; length?: number };

/** At most this many bytes per task (a demonstration, not a bulk copy). */
const MAX_TASK_BYTES = 64 * 1024 * 1024;

/** The bytes a `write` produces: the same generator the tests use. */
export function* patternChunks(size: number, seed: number, chunk: number): Generator<Uint8Array> {
  let x = seed >>> 0;
  for (let at = 0; at < size; at += chunk) {
    const b = new Uint8Array(Math.min(chunk, size - at));
    for (let i = 0; i < b.length; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      b[i] = x >>> 24;
    }
    yield b;
  }
}

async function digest(parts: Uint8Array[]) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function runStreamTask(cap: Cap, task: StreamTask) {
  const files = new CapFilesApi(cap);
  if (task.op === "write") {
    const size = Math.floor(Number(task.size));
    if (!(size >= 0 && size <= MAX_TASK_BYTES))
      throw new Error(`EINVAL: stream: size is 0..${MAX_TASK_BYTES}`);
    const chunk = Math.min(Math.max(Math.floor(Number(task.chunk) || 300_007), 1), 4 * 1024 * 1024);
    const parts = [...patternChunks(size, Number(task.seed) || 1, chunk)];
    await files.write(task.path, parts);
    return { bytes: size, chunks: parts.length, sha256: await digest(parts) };
  }
  if (task.op === "read") {
    const parts: Uint8Array[] = [];
    let bytes = 0;
    for await (const c of files.read(task.path, { start: task.start, length: task.length })) {
      bytes += c.length;
      if (bytes > MAX_TASK_BYTES)
        throw new Error(`EFBIG: stream: more than ${MAX_TASK_BYTES} bytes`);
      parts.push(c);
    }
    return { bytes, chunks: parts.length, sha256: await digest(parts) };
  }
  throw new Error("EINVAL: stream: op is write or read");
}
