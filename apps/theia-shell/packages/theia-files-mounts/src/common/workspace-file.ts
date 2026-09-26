import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";

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
 * per root — or undefined when nothing needs writing. Theia reads the file as
 * JSONC and keeps workspace settings in it, so only `folders` is edited:
 * comments, trailing commas and every other key stay. A file that cannot be
 * parsed is not rewritten (that would drop its settings): it throws.
 * `createOnly` (at startup): write only when there is no file yet.
 */
export function updateWorkspaceFile(
  existing: string | undefined,
  roots: readonly WorkspaceRoot[],
  options: { createOnly?: boolean } = {},
): string | undefined {
  const folders = roots.map((root) => ({ path: `file:///${root.key}`, name: root.name }));
  if (existing === undefined) return `${JSON.stringify({ folders }, null, 2)}\n`;
  if (options.createOnly) return undefined;
  const errors: ParseError[] = [];
  const data = parse(existing, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(
      "The workspace file is not valid JSON(C); fix it by hand — it is left as it is.",
    );
  }
  if (JSON.stringify(data.folders) === JSON.stringify(folders)) return undefined;
  const edits = modify(existing, ["folders"], folders, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return applyEdits(existing, edits);
}
