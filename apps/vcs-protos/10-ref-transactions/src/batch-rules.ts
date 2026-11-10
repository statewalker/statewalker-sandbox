/**
 * Backend-independent batch validation, as `git update-ref --stdin` applies it. Stub in red.
 */
import type { RefCommand, RejectReason } from "./ref-db.js";

/** Names a batch may touch: `HEAD`, or a valid two-level name under `refs/`. */
export function isUpdatableName(_name: string): boolean {
  throw new Error("not implemented");
}

/**
 * Static checks: invalid names, duplicates, and parent + child in one batch. `exists(name)` and
 * `hasChildren(name)` describe the current refs, for creates below or above an existing ref.
 */
export async function checkBatch(
  _commands: RefCommand[],
  _exists: (name: string) => Promise<boolean>,
  _hasChildren: (name: string) => Promise<boolean>,
): Promise<{ name: string; reason: RejectReason }[]> {
  throw new Error("not implemented");
}
