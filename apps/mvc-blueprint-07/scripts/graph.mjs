// Import-graph and LOC helpers shared by scripts/deps.mjs, scripts/loc.mjs and tests/boundaries.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

/** Drops comments, keeps string literals. */
export const stripComments = (text) =>
  text.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_m, literal) => literal ?? "",
  );

/** Every import: { spec, typeOnly }. Multi-line imports and dynamic import() included. */
export function imports(code) {
  const out = [];
  for (const m of code.matchAll(/\bimport\s+(type\s+)?[^"'`;]*?\bfrom\s*["']([^"']+)["']/g)) {
    out.push({ spec: m[2], typeOnly: Boolean(m[1]) });
  }
  for (const m of code.matchAll(/\bexport\s+(type\s+)?[^"'`;]*?\bfrom\s*["']([^"']+)["']/g)) {
    out.push({ spec: m[2], typeOnly: Boolean(m[1]) });
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g))
    out.push({ spec: m[1], typeOnly: false });
  for (const m of code.matchAll(/^import\s+["']([^"']+)["']/gm))
    out.push({ spec: m[1], typeOnly: false });
  return out;
}

/** A relative specifier resolved to an app-relative path without extension. */
export const resolve = (file, spec) =>
  /^\.\.?\//.test(spec)
    ? normalize(join(dirname(file), spec)).replace(/\.(js|ts|tsx)$/, "")
    : undefined;

/** The unit a file belongs to: a bundle folder, "kernel", "kit", "kit/react", or another src/ area. */
export function unitOf(path) {
  const m = path.match(/^src\/bundles\/([^/]+)(\/api)?/);
  if (m) return m[2] ? `${m[1]}/api` : m[1];
  if (path.startsWith("src/kit/react")) return "kit/react";
  const top = path.match(/^src\/([^/]+)\//);
  return top ? top[1] : path;
}
export const bundleOf = (unit) => unit.replace(/\/api$/, "");

export function sources(dir = "src") {
  return walk(join(ROOT, dir)).map((abs) => {
    const file = relative(ROOT, abs);
    return { file, code: stripComments(readFileSync(abs, "utf8")) };
  });
}

/** Bundle → module edges. */
export function graph() {
  const edges = [];
  for (const { file, code } of sources("src/bundles")) {
    const from = unitOf(file);
    for (const { spec, typeOnly } of imports(code)) {
      const target = resolve(file, spec);
      edges.push({
        file,
        from,
        to: target ? unitOf(target) : spec,
        spec,
        typeOnly,
        external: !target,
      });
    }
  }
  return edges;
}

/** Non-blank, non-comment lines. */
export function loc(files) {
  return files.reduce(
    (n, abs) =>
      n +
      stripComments(readFileSync(abs, "utf8"))
        .split("\n")
        .filter((l) => l.trim() !== "").length,
    0,
  );
}
