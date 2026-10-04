import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadText, writeText } from "@statewalker/webrun-files";

/**
 * Small JSON-over-FilesApi helpers shared by the FilesApi-backed Flue
 * persistence stores (`files-api-*-store.ts`).
 */

/**
 * Hex-encode an arbitrary string into a single safe path segment. Flue ids
 * and stream paths contain slashes (`agents/flue-workbench/workbench/x/main`),
 * which must never create nested directories or escape the store root.
 */
export function encodeSegment(value: string): string {
  return Array.from(new TextEncoder().encode(value))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Outcome of reading a JSON file: `missing` when the file does not exist,
 * `corrupt` when it exists but does not parse (torn write, hand edit, merge
 * conflict). Callers decide how to degrade — every store treats a corrupt
 * file as absent rather than crashing boot with an opaque SyntaxError.
 */
export type JsonReadResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing" }
  | { kind: "corrupt"; error: unknown };

export async function readJson<T>(files: FilesApi, path: string): Promise<JsonReadResult<T>> {
  const text = await tryReadText(files, path);
  if (text === undefined) return { kind: "missing" };
  try {
    return { kind: "ok", value: JSON.parse(text) as T };
  } catch (error) {
    return { kind: "corrupt", error };
  }
}

export async function writeJson(files: FilesApi, path: string, value: unknown): Promise<void> {
  await writeText(files, path, JSON.stringify(value));
}

/** Names of the direct children of `dir` (empty when `dir` does not exist). */
export async function listNames(
  files: FilesApi,
  dir: string,
  kind: "file" | "directory",
): Promise<string[]> {
  if (!(await files.exists(dir))) return [];
  const names: string[] = [];
  for await (const entry of files.list(dir)) {
    if (entry.kind === kind) names.push(entry.name);
  }
  return names.sort();
}

/**
 * Serialize async work. Every store funnels its FilesApi writes through one
 * of these so a later write to the same file can never land before an
 * earlier one (FilesApi writes are not ordered across concurrent calls).
 */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves once every queued task has finished. */
  drain(): Promise<void> {
    return this.tail;
  }
}
