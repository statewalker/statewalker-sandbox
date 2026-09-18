import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { importsOf } from "./graph.js";

/**
 * SUBSTRATE REACH (P4 acceptance 3) — which bundles depend on the reactive library, measured the
 * same way over P0's sources (`../mvc-blueprint-04`) and P4's (this app):
 *
 * - runtime reach: the bundle's value-import closure (index.ts and its own files, through
 *   `@kernel`, `@kit/*`, API modules) contains an `alien-signals` import;
 * - contract reach: the bundle's code or an API module it imports names the substrate's type
 *   (`Readable`) — i.e. its published contract is expressed in the substrate;
 * - API modules that import a library (value or type) other than the kernel.
 */
const APP = new URL("../../", import.meta.url).pathname;
const P0 = join(APP, "../mvc-blueprint-04/");

interface File {
  readonly path: string;
  readonly code: string;
}

function load(root: string): Map<string, File> {
  const out = new Map<string, File>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const rel = relative(root, p);
        out.set(rel, { path: rel, code: readFileSync(p, "utf8") });
      }
    }
  };
  walk(join(root, "src"));
  return out;
}

function target(files: Map<string, File>, from: string, spec: string): string | undefined {
  let base: string | undefined;
  if (spec === "@kernel") base = "src/kernel/index";
  else if (spec.startsWith("@kit/")) base = `src/kits/${spec.slice(5)}/index`;
  else if (spec.startsWith("@b/")) base = `src/bundles/${spec.slice(3)}/index`;
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec)).replace(/\.js$/, "");
  if (!base) return undefined;
  for (const ext of [".ts", ".tsx", "/index.ts"]) if (files.has(base + ext)) return base + ext;
  return undefined;
}

/** Whether the value-import closure of `start` (through kernel, kits, API modules) reaches alien-signals. */
function reachesAlien(files: Map<string, File>, start: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    const file = files.get(f);
    if (!file) continue;
    for (const i of importsOf(file.code)) {
      if (i.typeOnly) continue;
      if (/^alien-signals/.test(i.spec)) return true;
      // Another bundle's implementation is not reached (the boundary suite forbids it), but
      // `features/` would — start from the bundle's own files only.
      const t = target(files, f, i.spec);
      if (t) stack.push(t);
    }
  }
  return false;
}

function report(root: string) {
  const files = load(root);
  const bundles = new Map<string, string[]>();
  for (const p of files.keys()) {
    const m = /^src\/bundles\/([^/]+)\/(?!api\/)/.exec(p);
    if (m) bundles.set(m[1] as string, [...(bundles.get(m[1] as string) ?? []), p]);
  }
  const runtime: string[] = [];
  const contract: string[] = [];
  for (const [name, own] of [...bundles].sort(([a], [b]) => a.localeCompare(b))) {
    if (own.some((f) => reachesAlien(files, f))) runtime.push(name);
    const apis = new Set<string>();
    for (const f of own)
      for (const i of importsOf((files.get(f) as File).code)) {
        const t = target(files, f, i.spec);
        if (t?.includes("/api/")) apis.add(t);
      }
    const mentions = (code: string) => /\bReadable\b/.test(code);
    if (own.some((f) => mentions((files.get(f) as File).code))) contract.push(name);
    else if ([...apis].some((a) => mentions((files.get(a) as File).code))) {
      // imports an API module whose contract is expressed in the substrate — and uses a changed facet
      const code = own.map((f) => (files.get(f) as File).code).join("\n");
      if (/todosCollectionSlot|todosSelectionSlot|contactsSelectionSlot/.test(code))
        contract.push(name);
    }
  }
  const apiModules = [...files.keys()].filter((p) => /\/api\/(?:[^/]+\/)?index\.ts$/.test(p));
  const apiLibraryImports = apiModules.flatMap((p) =>
    importsOf((files.get(p) as File).code)
      .filter((i) => !/^@kernel$|^@b\/|^\./.test(i.spec))
      .map((i) => `${p} → ${i.spec}`),
  );
  const apiSubstrateTypes = apiModules.filter((p) =>
    /\bReadable\b/.test((files.get(p) as File).code),
  );
  return { bundles: bundles.size, runtime, contract, apiLibraryImports, apiSubstrateTypes };
}

describe("substrate reach (P0 vs P4)", () => {
  it("reports which bundles depend on the reactive library", () => {
    const p0 = report(P0);
    const p4 = report(APP);
    const fmt = (label: string, r: ReturnType<typeof report>) =>
      [
        `${label}: ${r.bundles} bundles`,
        `  runtime reach to alien-signals: ${r.runtime.length} — ${r.runtime.join(", ")}`,
        `  contract expressed in the substrate: ${r.contract.length} — ${r.contract.join(", ")}`,
        `  API modules naming a substrate type: ${r.apiSubstrateTypes.length} ${r.apiSubstrateTypes.join(", ")}`,
        `  API modules importing a library: ${r.apiLibraryImports.length} ${r.apiLibraryImports.join(", ")}`,
      ].join("\n");
    console.info(`[substrate]\n${fmt("P0", p0)}\n${fmt("P4", p4)}`);
    expect(p4.apiLibraryImports).toEqual(p0.apiLibraryImports); // only shell/api/react → react
    expect(p0.contract).toEqual([]);
    expect(p4.apiSubstrateTypes.length).toBe(2);
  });
});
