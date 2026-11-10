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
    async append(path, content) {
      const old = files.get(path) ?? new Uint8Array(0);
      const next = new Uint8Array(old.length + content.length);
      next.set(old);
      next.set(content, old.length);
      files.set(path, next);
    },
    async removeEmptyDir() {
      return false; // no directories in memory: a name is free once no file has it
    },
    paths: () => [...files.keys()].sort(),
  };
}
