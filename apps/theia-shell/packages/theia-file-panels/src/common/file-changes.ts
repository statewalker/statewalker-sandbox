import type URI from "@theia/core/lib/common/uri";
import type { FileChange } from "@theia/filesystem/lib/common/files";

/**
 * True when one of `changes` is `uri` itself, or an ancestor of it (e.g. a
 * mount root re-created after a vault unlock, or a folder rename).
 *
 * Theia's own `FileChangesEvent.contains()` widens ancestor matching only for
 * `DELETED` changes; a mount coming back announces `updated`, not `deleted`
 * (`MountTable.apply`), so this checks every change type the same way.
 */
export function touchesFile(changes: readonly FileChange[], uri: URI): boolean {
  return changes.some((change) => change.resource.isEqualOrParent(uri));
}
