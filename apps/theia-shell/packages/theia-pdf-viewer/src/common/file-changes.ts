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

/**
 * Whether a viewer of `uri` reloads on a files change: on a change to its file
 * — as Theia's `FileChangesEvent.contains` has it (the file itself, or a
 * deleted ancestor) — and, only while the file cannot be read (`unreadable`),
 * on any change to an ancestor too (a mount re-created), which is how it
 * recovers. A readable viewer ignores ancestor-only changes (a `files.hidden`
 * edit, a mount re-applied), which would otherwise reset its page and zoom.
 */
export function reloadsOn(
  event: { readonly changes: readonly FileChange[]; contains(resource: URI): boolean },
  uri: URI,
  unreadable: boolean,
): boolean {
  return event.contains(uri) || (unreadable && touchesFile(event.changes, uri));
}
