import { opfsAtomicFiles } from "../../../07-lockfile-cas/src/adapters/opfs.js";
import type { RefFiles } from "../files-ref-db.js";

/** OPFS RefFiles: X2's primitives (Web Lock exclusive create) plus write and list. */
export function opfsRefFiles(root: FileSystemDirectoryHandle): RefFiles {
  const base = opfsAtomicFiles(root);
  const dirOf = async (parts: string[]) => {
    let d = root;
    for (const p of parts) d = await d.getDirectoryHandle(p);
    return d;
  };
  const gone = (e: unknown) => (e as DOMException)?.name === "NotFoundError";
  const changed = (e: unknown) => (e as DOMException)?.name === "NotReadableError";
  return {
    ...base,
    // A concurrent writer may remove or replace a file between the handle lookup and the read
    // (a released lock, a loose ref moved into packed-refs, packed-refs committed through
    // createWritable). On a POSIX file system the reader would see the file absent or the new
    // version; do the same here: NotFoundError = absent, NotReadableError = read again.
    async *read(path) {
      for (let attempt = 0; ; attempt++) {
        try {
          const chunks: Uint8Array[] = [];
          for await (const c of base.read(path)) chunks.push(c);
          yield* chunks;
          return;
        } catch (e) {
          if (gone(e)) return;
          if (changed(e) && attempt < 5) continue;
          throw e;
        }
      }
    },
    async exists(path) {
      try {
        return await base.exists(path);
      } catch (e) {
        if (gone(e)) return false;
        throw e;
      }
    },
    async write(path, content) {
      const parts = path.split("/").filter(Boolean);
      const name = parts.pop() as string;
      const h = await (await dirOf(parts)).getFileHandle(name);
      const w = await h.createWritable();
      await w.write(content as Uint8Array<ArrayBuffer>);
      await w.close();
    },
    async *list(dir) {
      const parts = dir.split("/").filter(Boolean);
      let d: FileSystemDirectoryHandle;
      try {
        d = await dirOf(parts);
      } catch {
        return;
      }
      const out: string[] = [];
      const walk = async (h: FileSystemDirectoryHandle, prefix: string) => {
        try {
          for await (const [name, child] of (
            h as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
          ).entries()) {
            if (child.kind === "file") out.push(`${prefix}/${name}`);
            else await walk(child as FileSystemDirectoryHandle, `${prefix}/${name}`);
          }
        } catch (e) {
          if (!gone(e)) throw e; // a directory removed while listing: nothing more under it
        }
      };
      await walk(d, parts.join("/"));
      yield* out.sort();
    },
  };
}
