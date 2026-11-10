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
  return {
    ...base,
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
        for await (const [name, child] of (
          h as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
        ).entries()) {
          if (child.kind === "file") out.push(`${prefix}/${name}`);
          else await walk(child as FileSystemDirectoryHandle, `${prefix}/${name}`);
        }
      };
      await walk(d, parts.join("/"));
      yield* out.sort();
    },
  };
}
