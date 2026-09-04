// RECOVERED-FROM-ARCHIVE: notes/drive/2026-09-02.Httpeers-Shell/13-prototype-04-manifest-generation.tar.gz
// Unmodified.
import type { ManifestMenuItem } from "./generate.js";

/**
 * Runtime side of a menu contribution.
 *
 * The generator recognises calls to this function SYNTACTICALLY and never
 * executes them. At runtime it registers with the host; at build time the
 * same call site is the declaration the manifest is derived from. One
 * source of truth, two readings.
 */
const pending: ManifestMenuItem[] = [];

export function contributeMenu(item: ManifestMenuItem): void {
  pending.push(item);
}

export function drainContributions(): ManifestMenuItem[] {
  return pending.splice(0, pending.length);
}
