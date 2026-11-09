import type { AtomicFiles } from "../lockfile.js";
/** In-memory AtomicFiles. STUB. */
export function memAtomicFiles(): AtomicFiles & { snapshot(): Map<string, Uint8Array> } {
  throw new Error("not implemented");
}
