import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AtomicFiles } from "../lockfile.js";

/**
 * Node fs AtomicFiles rooted at a directory. createExclusive = open(…, "wx") (O_CREAT|O_EXCL), the
 * call git and JGit's createNewFile rely on; replace = rename(2), atomic on POSIX file systems.
 */
export function nodeAtomicFiles(root: string): AtomicFiles {
  const abs = (p: string) => join(root, p);
  const isErr = (e: unknown, code: string) => (e as NodeJS.ErrnoException)?.code === code;
  return {
    async *read(path) {
      try {
        yield new Uint8Array(await readFile(abs(path)));
      } catch (e) {
        if (!isErr(e, "ENOENT")) throw e;
      }
    },
    async exists(path) {
      try {
        await stat(abs(path));
        return true;
      } catch (e) {
        if (isErr(e, "ENOENT")) return false;
        throw e;
      }
    },
    async remove(path) {
      const existed = await this.exists(path);
      await rm(abs(path), { force: true, recursive: true });
      return existed;
    },
    async createExclusive(path, content) {
      await mkdir(dirname(abs(path)), { recursive: true });
      let fh: Awaited<ReturnType<typeof open>>;
      try {
        fh = await open(abs(path), "wx");
      } catch (e) {
        if (isErr(e, "EEXIST")) return false;
        throw e;
      }
      try {
        await fh.writeFile(content);
      } finally {
        await fh.close();
      }
      return true;
    },
    async replace(source, target) {
      await mkdir(dirname(abs(target)), { recursive: true });
      await rename(abs(source), abs(target));
    },
  };
}
