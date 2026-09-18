import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

/**
 * The import graph of `src/`, by regex (as 03's B0). A module is a folder (a bundle, an API
 * module, a kit, the kernel); edges are imports between modules.
 */
export const ROOT = new URL("../../", import.meta.url).pathname;

const stripComments = (text: string) =>
  text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      (_m, literal: string | undefined) => literal ?? "",
    );

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx|svelte)$/.test(e.name) ? [p] : [];
  });
}

export interface Import {
  readonly spec: string;
  /** `import type …` (erased). */
  readonly typeOnly: boolean;
}

export interface Source {
  readonly file: string;
  readonly code: string;
  readonly imports: Import[];
}

/** Every import / export-from / dynamic import, with whether it is type-only. */
export function importsOf(code: string): Import[] {
  const out: Import[] = [];
  for (const m of code.matchAll(
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?\s+from\s+["']([^"']+)["']/g,
  )) {
    out.push({ spec: m[3], typeOnly: Boolean(m[2]) });
  }
  for (const m of code.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g))
    out.push({ spec: m[1], typeOnly: false });
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g))
    out.push({ spec: m[1], typeOnly: false });
  return out;
}

/** A `.svelte` file's imports live in its `<script>` blocks; its code (for R2) is the whole file. */
const scriptOf = (path: string, code: string) =>
  path.endsWith(".svelte")
    ? [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n")
    : code;

export function sources(dir = "src"): Source[] {
  return walk(join(ROOT, dir)).map((path) => {
    const code = stripComments(readFileSync(path, "utf8"));
    return { file: relative(ROOT, path), code, imports: importsOf(scriptOf(path, code)) };
  });
}

/** Where an import lands: a path under src/ (for aliases and relatives) or an external package. */
export function resolve(file: string, spec: string): { path?: string; external?: string } {
  if (spec === "@kernel") return { path: "src/kernel/index.ts" };
  const kit = /^@kit\/(.+)$/.exec(spec);
  if (kit) return { path: `src/kits/${kit[1]}/index.ts` };
  const b = /^@b\/(.+)$/.exec(spec);
  if (b) return { path: `src/bundles/${b[1]}/index.ts` };
  if (/^\.\.?\//.test(spec)) return { path: normalize(join(dirname(file), spec)) };
  return { external: spec };
}

/** The module a file belongs to: "kernel", "kit:<name>", "api:<path>", "bundle:<name>", "app". */
export function moduleOf(path: string): string {
  if (path.startsWith("src/kernel/")) return "kernel";
  const kit = /^src\/kits\/([^/]+)\//.exec(path);
  if (kit) return `kit:${kit[1]}`;
  const api = /^src\/bundles\/(.+?\/api(?:\/(?:react|dom|svelte|solid|vue))?)\//.exec(path);
  if (api) return `api:${api[1]}`;
  const bundle = /^src\/bundles\/([^/]+)\//.exec(path);
  if (bundle) return `bundle:${bundle[1]}`;
  return "app";
}

/** The bundle that owns a module (an API module belongs to its declaring bundle folder). */
export const ownerOf = (module: string) =>
  module.startsWith("api:") ? `bundle:${module.slice(4).split("/")[0]}` : module;

export const isUiBundle = (name: string) => /\.ui\.|^shell\.(svelte|solid|vue)$/.test(name);
export const isRendererBundle = (name: string) => /\.ui\./.test(name);

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly file: string;
  readonly spec: string;
}

export function edges(all: readonly Source[]): Edge[] {
  const out: Edge[] = [];
  for (const s of all) {
    const from = moduleOf(s.file);
    for (const i of s.imports) {
      const { path } = resolve(s.file, i.spec);
      if (!path) continue;
      const to = moduleOf(path);
      if (to !== from) out.push({ from, to, file: s.file, spec: i.spec });
    }
  }
  return out;
}

/** A cross-bundle edge: between two different bundle folders. Allowed only onto an API module. */
export function crossBundle(all: readonly Edge[]): { edge: Edge; ok: boolean }[] {
  return all
    .filter((e) => e.from.startsWith("bundle:") || e.from.startsWith("api:"))
    .filter(
      (e) =>
        (e.to.startsWith("bundle:") || e.to.startsWith("api:")) &&
        ownerOf(e.from) !== ownerOf(e.to),
    )
    .map((edge) => ({ edge, ok: edge.to.startsWith("api:") }));
}
