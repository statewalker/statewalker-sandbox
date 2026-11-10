import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeAtomicFiles } from "../../../07-lockfile-cas/src/adapters/node.js";
import type { RefFiles } from "../files-ref-db.js";

/** Node RefFiles rooted at a git directory (`.git`): X2's primitives plus write and list. */
export function nodeRefFiles(root: string): RefFiles {
  const base = nodeAtomicFiles(root);
  const isFile = async (p: string) => {
    try {
      return (await stat(join(root, p))).isFile();
    } catch {
      return false;
    }
  };
  return {
    ...base,
    async *read(path) {
      if (await isFile(path)) yield* base.read(path);
    },
    exists: isFile,
    async write(path, content) {
      await writeFile(join(root, path), content);
    },
    async *list(dir) {
      let entries: string[];
      try {
        entries = (await readdir(join(root, dir), { recursive: true })) as string[];
      } catch {
        return;
      }
      const out: string[] = [];
      for (const e of entries) {
        const p = `${dir.replace(/\/$/, "")}/${e.split("\\").join("/")}`;
        if (await isFile(p)) out.push(p);
      }
      yield* out.sort();
    },
  };
}
