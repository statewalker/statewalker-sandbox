import type { AtomicFiles } from "../lockfile.js";

/**
 * OPFS AtomicFiles over a directory handle. OPFS has no exclusive create, so createExclusive runs its
 * check-then-create inside a Web Lock named after the path; Web Locks are shared by every page and
 * worker of the origin, which is the whole set of OPFS writers (native git cannot reach OPFS).
 * replace writes the target through createWritable, which OPFS commits atomically on close, then
 * removes the source: the target is updated atomically, the source removal may lag (a crash in
 * between leaves the source behind — for a lock, a stale lock reported as `locked`).
 * Exclusivity holds only among callers using these Web Lock names in the same origin and storage
 * partition. (createSyncAccessHandle's exclusive per-file lock is an alternative in workers.)
 */
export function opfsAtomicFiles(root: FileSystemDirectoryHandle): AtomicFiles {
  const split = (path: string) => {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error(`invalid path ${path}`);
    return { parts, name };
  };
  const dirOf = async (parts: string[], create: boolean) => {
    let d = root;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  };
  const fileHandle = async (path: string): Promise<FileSystemFileHandle | undefined> => {
    const { parts, name } = split(path);
    try {
      return await (await dirOf(parts, false)).getFileHandle(name);
    } catch (e) {
      if (
        (e as DOMException).name === "NotFoundError" ||
        (e as DOMException).name === "TypeMismatchError"
      )
        return undefined;
      throw e;
    }
  };
  const writeFile = async (path: string, content: Uint8Array) => {
    const { parts, name } = split(path);
    const h = await (await dirOf(parts, true)).getFileHandle(name, { create: true });
    const w = await h.createWritable();
    await w.write(content as Uint8Array<ArrayBuffer>);
    await w.close();
  };
  const withPathLock = <T>(path: string, fn: () => Promise<T>) =>
    navigator.locks.request(`atomic-files:${path}`, fn) as Promise<T>;

  const self: AtomicFiles = {
    async *read(path) {
      const h = await fileHandle(path);
      if (h) yield new Uint8Array(await (await h.getFile()).arrayBuffer());
    },
    async exists(path) {
      return (await fileHandle(path)) !== undefined;
    },
    async remove(path) {
      const { parts, name } = split(path);
      try {
        await (await dirOf(parts, false)).removeEntry(name, { recursive: true });
        return true;
      } catch (e) {
        if ((e as DOMException).name === "NotFoundError") return false;
        throw e;
      }
    },
    createExclusive: (path, content) =>
      withPathLock(path, async () => {
        if (await fileHandle(path)) return false;
        try {
          await writeFile(path, content);
        } catch (e) {
          await self.remove(path).catch(() => false); // roll back a half-created lock
          throw e;
        }
        return true;
      }),
    async replace(source, target) {
      const h = await fileHandle(source);
      if (!h) throw new Error(`replace: ${source} does not exist`);
      await writeFile(target, new Uint8Array(await (await h.getFile()).arrayBuffer()));
      await self.remove(source);
    },
  };
  return self;
}
