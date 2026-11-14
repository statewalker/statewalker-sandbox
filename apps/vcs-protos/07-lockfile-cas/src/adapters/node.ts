import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AtomicFiles } from "../lockfile.js";

/**
 * Node fs AtomicFiles rooted at a directory. createExclusive = open(…, "wx") (O_CREAT|O_EXCL), the
 * call git and JGit's createNewFile rely on; replace = rename(2), atomic on POSIX file systems.
 */
export function nodeAtomicFiles(
  root: string,
  opts: { failWriteForTest?: boolean } = {},
): AtomicFiles {
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
      // unlink, not stat + rm: only the caller that actually removed the file gets true.
      try {
        await unlink(abs(path));
        return true;
      } catch (e) {
        if (isErr(e, "ENOENT")) return false;
        throw e;
      }
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
        if (opts.failWriteForTest) throw new Error("write failed (test)");
        await fh.writeFile(content);
        await fh.close();
      } catch (e) {
        // Roll back a half-written lock, as git does; otherwise it would block writers forever.
        await fh.close().catch(() => {});
        await unlink(abs(path)).catch(() => {});
        throw e;
      }
      return true;
    },
    async replace(source, target) {
      await mkdir(dirname(abs(target)), { recursive: true });
      await rename(abs(source), abs(target));
    },
  };
}
