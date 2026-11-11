/** X14 — the full lstat on Node, for the index's stat data */

import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { StatInfo } from "./worktree.js";

export function nodeStat(root: string): (path: string) => Promise<StatInfo | undefined> {
  return async (path) => {
    try {
      const st = await lstat(join(root, path), { bigint: true });
      if (!st.isFile()) return undefined;
      return {
        size: Number(st.size),
        mtimeMs: Number(st.mtimeNs / 1_000_000n),
        mtimeNs: st.mtimeNs,
        ctimeNs: st.ctimeNs,
        dev: Number(st.dev & 0xffffffffn),
        ino: Number(st.ino & 0xffffffffn),
        uid: Number(st.uid),
        gid: Number(st.gid),
      };
    } catch {
      return undefined;
    }
  };
}

/** a symlink's target, for its blob */
export function nodeReadLink(_root: string): (path: string) => Promise<string> {
  return async () => {
    throw new Error("not implemented");
  };
}
