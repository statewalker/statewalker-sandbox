/**
 * The system mount holding the workspace file: the main storage's
 * `/.shell/workspace`, at `/.workspace`. It is never a root. (Theia 1.76 opens
 * only `file:` workspaces, so the file must be in the `file:` tree.)
 */
export const WORKSPACE_MOUNT_KEY = ".workspace";

/** The multi-root workspace whose folders are the mounts. */
export const WORKSPACE_FILE_URI = `file:///${WORKSPACE_MOUNT_KEY}/mounts.theia-workspace`;

/** A workspace root: a mount's key and display name. */
export interface WorkspaceRoot {
  key: string;
  name: string;
}

/** The mounts that are workspace roots: all but system mounts (keys starting with a dot). */
export function workspaceRoots(mounts: readonly WorkspaceRoot[]): WorkspaceRoot[] {
  return mounts.filter((m) => !m.key.startsWith("."));
}

/**
 * The workspace file's text with `folders` set to one `file:///<key>` (named)
 * per root, everything else kept — or undefined when `folders` already matches.
 */
export function updateWorkspaceFile(
  existing: string | undefined,
  roots: readonly WorkspaceRoot[],
): string | undefined {
  let data: Record<string, unknown> = {};
  if (existing !== undefined) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
    } catch {
      data = {};
    }
  }
  const folders = roots.map((root) => ({ path: `file:///${root.key}`, name: root.name }));
  if (existing !== undefined && JSON.stringify(data.folders) === JSON.stringify(folders))
    return undefined;
  return `${JSON.stringify({ ...data, folders }, null, 2)}\n`;
}
