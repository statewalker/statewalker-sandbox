import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** A directory's files (path → bytes), without node_modules and dot entries. */
export function readTree(dir: string, base = dir): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const f = join(dir, n);
    if (statSync(f).isDirectory()) for (const [p, b] of readTree(f, base)) out.set(p, b);
    else out.set(`/${relative(base, f)}`, readFileSync(f));
  }
  return out;
}
