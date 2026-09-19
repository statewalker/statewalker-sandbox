import type { ApplicationManifest } from "@p5/kernel";

/**
 * A copy of `manifest` without the features in `ids` and every feature that (transitively)
 * requires one of them. Returns the removed ids too.
 */
export function without(
  manifest: ApplicationManifest,
  ...ids: string[]
): { manifest: ApplicationManifest; removed: string[] } {
  const removed = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of manifest.features) {
      if (!removed.has(f.id) && (f.requires ?? []).some((r) => removed.has(r))) {
        removed.add(f.id);
        changed = true;
      }
    }
  }
  return {
    manifest: {
      id: `${manifest.id}-without-${ids.join("+")}`,
      features: manifest.features.filter((f) => !removed.has(f.id)),
    },
    removed: [...removed],
  };
}
