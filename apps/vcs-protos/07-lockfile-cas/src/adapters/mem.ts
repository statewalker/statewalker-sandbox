import type { AtomicFiles } from "../lockfile.js";

/**
 * In-memory AtomicFiles. Every primitive does its check-and-mutate synchronously, with no await in
 * between, so concurrent callers on the event loop cannot interleave inside one.
 */
export function memAtomicFiles(): AtomicFiles & { snapshot(): Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    async *read(path) {
      const v = files.get(path);
      if (v) yield v.slice();
    },
    async exists(path) {
      return files.has(path);
    },
    async remove(path) {
      return files.delete(path);
    },
    async createExclusive(path, content) {
      if (files.has(path)) return false;
      files.set(path, content.slice());
      return true;
    },
    async replace(source, target) {
      const v = files.get(source);
      if (!v) throw new Error(`replace: ${source} does not exist`);
      files.set(target, v);
      files.delete(source);
    },
    snapshot: () => new Map(files),
  };
}
