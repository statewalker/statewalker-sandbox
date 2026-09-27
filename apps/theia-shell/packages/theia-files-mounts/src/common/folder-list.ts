import { isMounted } from "./mount-config";
import type { MountConfig, MountType } from "./mount-types";

/** One row of *Add Folder to Workspace…*. */
export type FolderListItem =
  | { kind: "remembered"; mount: MountConfig; label: string; description: string }
  | { kind: "opfs"; directory: string; label: string; description: string }
  | { kind: "new"; typeId: string; label: string };

/**
 * The folders that can be added to the workspace: remembered mounts (in
 * `files.mounts` order), browser-storage folders no entry refers to (sorted),
 * then one "New …" row per available type.
 */
export function buildFolderList(
  entries: readonly MountConfig[],
  types: ReadonlyMap<string, MountType>,
  opfsDirectories: readonly string[],
): FolderListItem[] {
  const typeLabel = (id: string) => types.get(id)?.label ?? id;
  // A hand-edited files.mounts may hold anything: list only well-formed entries.
  entries = entries.filter(
    (m): m is MountConfig =>
      typeof m === "object" &&
      m !== null &&
      typeof m.key === "string" &&
      typeof m.name === "string" &&
      typeof m.type === "string" &&
      typeof m.config === "object" &&
      m.config !== null,
  );
  const remembered: FolderListItem[] = entries
    .filter((m) => !isMounted(m))
    .map((mount) => ({
      kind: "remembered",
      mount,
      label: mount.name,
      description: typeLabel(mount.type),
    }));
  const used = new Set(entries.filter((m) => m.type === "opfs").map((m) => m.config.directory));
  const opfs: FolderListItem[] = types.has("opfs")
    ? [...opfsDirectories]
        .filter((d) => !used.has(d))
        .sort()
        .map((directory) => ({
          kind: "opfs",
          directory,
          label: directory,
          description: typeLabel("opfs"),
        }))
    : [];
  const fresh: FolderListItem[] = [...types.values()]
    .filter((t) => t.isAvailable())
    .map((t) => ({ kind: "new", typeId: t.id, label: t.newLabel ?? `New ${t.label}…` }));
  return [...remembered, ...opfs, ...fresh];
}
