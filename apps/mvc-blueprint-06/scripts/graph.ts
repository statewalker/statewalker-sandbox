/**
 * Static analysis shared by the boundary suite and the reports: the import graph between bundles,
 * and the per-file rules. Regex over comment-stripped source; every rule has a negative control in
 * tests/boundaries.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

export const APP_ROOT = new URL("../", import.meta.url).pathname;

export const stripComments = (text: string): string =>
  text.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_m, literal: string | undefined) => literal ?? "",
  );

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

export interface Source {
  readonly file: string; // relative to the app root, e.g. src/bundles/todos.list/index.ts
  readonly code: string;
}

export const sources = (dir = "src"): Source[] =>
  walk(join(APP_ROOT, dir)).map((p) => ({
    file: relative(APP_ROOT, p),
    code: stripComments(readFileSync(p, "utf8")),
  }));

export interface Import {
  readonly spec: string;
  readonly typeOnly: boolean;
  /** Resolved path relative to the app root, for relative specifiers. */
  readonly target?: string;
}

export function imports(s: Source): Import[] {
  return [...s.code.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].map(
    (m) => {
      const spec = m[3] as string;
      const target = /^\.\.?\//.test(spec)
        ? normalize(join(dirname(s.file), spec)).replace(/\.js$/, "")
        : undefined;
      return { spec, typeOnly: m[2] !== undefined, target };
    },
  );
}

/** The unit a file belongs to: a bundle id, "api:<bundle>", "kernel", "kit", "kit/react", or "app". */
export function unitOf(file: string): string {
  const b = /^src\/bundles\/([^/]+)\/(api)?/.exec(file);
  if (b) return b[2] ? `api:${b[1]}` : (b[1] as string);
  if (file.startsWith("src/kernel/")) return "kernel";
  if (file.startsWith("src/kit/react/")) return "kit/react";
  if (file.startsWith("src/kit/")) return "kit";
  return "app"; // features, apps, main: the composition root
}

export const isBundle = (unit: string) =>
  !unit.startsWith("api:") && !["kernel", "kit", "kit/react", "app"].includes(unit);
export const isUiBundle = (unit: string) => unit.endsWith(".ui.react") || unit === "shell.react";

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly file: string;
}

/** Bundle → module edges that leave the bundle (to kernel, kit, an API, or another bundle). */
export function bundleEdges(all: Source[]): Edge[] {
  const edges: Edge[] = [];
  for (const s of all) {
    const from = unitOf(s.file);
    if (!isBundle(from)) continue;
    for (const i of imports(s)) {
      if (!i.target) continue;
      const to = unitOf(`${i.target}.ts`);
      if (to !== from) edges.push({ from, to, file: s.file });
    }
  }
  return edges;
}

export interface Graph {
  readonly bundles: string[];
  readonly crossBundleEdges: number;
  readonly toApi: number;
  readonly violations: Edge[];
  readonly fanOut: Record<string, string[]>;
}

export function graph(all: Source[]): Graph {
  const edges = bundleEdges(all);
  const unique = new Map(edges.map((e) => [`${e.from}→${e.to}`, e]));
  const cross = [...unique.values()].filter((e) => e.to !== "kernel" && !e.to.startsWith("kit"));
  const fanOut: Record<string, string[]> = {};
  for (const e of unique.values()) (fanOut[e.from] ??= []).push(e.to);
  for (const k of Object.keys(fanOut)) fanOut[k]?.sort();
  return {
    bundles: [...new Set(all.map((s) => unitOf(s.file)).filter(isBundle))].sort(),
    crossBundleEdges: cross.length,
    toApi: cross.filter((e) => e.to.startsWith("api:")).length,
    violations: cross.filter((e) => !e.to.startsWith("api:")),
    fanOut,
  };
}
