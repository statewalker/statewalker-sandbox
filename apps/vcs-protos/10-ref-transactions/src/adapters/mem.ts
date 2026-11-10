import type { RefFiles } from "../files-ref-db.js";

/** In-memory RefFiles: one Map, every primitive synchronous inside (no interleaving). */
export function memRefFiles(): RefFiles & { paths(): string[] } {
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
    async write(path, content) {
      files.set(path, content.slice());
    },
    async *list(dir) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      for (const p of [...files.keys()].sort()) if (p.startsWith(prefix)) yield p;
    },
    paths: () => [...files.keys()].sort(),
  };
}
