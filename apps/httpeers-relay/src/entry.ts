/**
 * "Was this module run, or imported?" -- the guard both runnable modules in
 * this package use.
 *
 * `realpathSync` is not decoration. `apps/httpeers-stack` starts the relay as
 * `tsx node_modules/@statewalker/httpeers-relay/src/main.ts`, and pnpm makes
 * that path a symlink into `apps/httpeers-relay`. The loader resolves
 * `import.meta.url` through the link while `process.argv[1]` keeps the
 * symlinked spelling, so the usual
 * `import.meta.url === \`file://${process.argv[1]}\`` comparison is false: the
 * process starts, imports the module, defines everything, and exits 0 having
 * relayed nothing. That failure is completely silent, which is why the fix
 * lives in one named function rather than being copied twice and fixed once.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isProcessEntry(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry == null) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
