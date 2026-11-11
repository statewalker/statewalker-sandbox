/** X14 — the full lstat on Node, for the index's stat data */

import type { StatInfo } from "./worktree.js";

export function nodeStat(_root: string): (path: string) => Promise<StatInfo | undefined> {
  throw new Error("not implemented");
}
