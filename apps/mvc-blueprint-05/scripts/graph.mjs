/**
 * The import graph of src/, by regex (as 03's B0): every edge file → module, classified by bundle.
 * Shared by the boundary suite (tests/boundaries) and the dependency report (scripts/deps.mjs).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(APP, "src");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [],
  );
}

/** "src/bundles/todos.list/index.ts" → { bundle: "todos.list", api: false } */
export function classify(path) {
  const m = /^src\/bundles\/([^/]+)\/(.*)$/.exec(path);
  if (m) return { area: "bundle", bundle: m[1], api: m[2].startsWith("api/") };
  if (path.startsWith("src/kernel/")) return { area: "kernel" };
  return { area: "app" }; // features, apps, main
}
export const isUiBundle = (b) => b.endsWith(".ui.react") || b === "shell.react";

export function edges() {
  const out = [];
  for (const file of walk(SRC)) {
    const from = relative(APP, file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      const to = spec.startsWith(".") ? relative(APP, resolve(dirname(file), spec)) : spec;
      const names = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']/.exec(
        text.slice(text.lastIndexOf("import", m.index), m.index + m[0].length),
      );
      out.push({ from, to, external: !spec.startsWith("."), names: names ? names[1] : "" });
    }
  }
  return out;
}

/** Each rule: (edge) → a violation message or undefined. */
export const rules = {
  "kernel imports no bundle": (e) =>
    classify(e.from).area === "kernel" && !e.external && classify(e.to).area !== "kernel"
      ? `${e.from} → ${e.to}`
      : undefined,
  "cross-bundle edges target API modules": (e) => {
    const a = classify(e.from);
    const b = classify(e.to);
    return a.area === "bundle" && b.area === "bundle" && a.bundle !== b.bundle && !b.api
      ? `${e.from} → ${e.to}`
      : undefined;
  },
  "API modules import only the kernel and API modules": (e) => {
    const a = classify(e.from);
    if (a.area !== "bundle" || !a.api) return undefined;
    if (e.external)
      return e.to === "react" && e.from.endsWith("/react.ts") ? undefined : `${e.from} → ${e.to}`;
    const b = classify(e.to);
    return b.area === "kernel" || (b.area === "bundle" && b.api)
      ? undefined
      : `${e.from} → ${e.to}`;
  },
  "logic bundles import no UI library": (e) => {
    const a = classify(e.from);
    const ui = a.area === "bundle" && (isUiBundle(a.bundle) || e.from.endsWith("/api/react.ts"));
    return a.area === "bundle" && !ui && e.external && /^react(-dom)?(\/|$)/.test(e.to)
      ? `${e.from} → ${e.to}`
      : undefined;
  },
  "renderers reach no store, api service or effect": (e) => {
    const a = classify(e.from);
    if (a.area !== "bundle" || !a.bundle.endsWith(".ui.react") || e.from.endsWith("/index.ts"))
      return undefined;
    if (
      /\b(getStore|createStore|useStore|Fx\b|todoApiFx|TODO_API_KEY|CONTACT_API_KEY|Effect)\b/.test(
        e.names,
      )
    )
      return `${e.from} imports { ${e.names.trim()} }`;
    return /mem-api/.test(e.to) ? `${e.from} → ${e.to}` : undefined;
  },
};

export function check(list = edges()) {
  const violations = {};
  for (const [name, rule] of Object.entries(rules)) {
    violations[name] = list.map(rule).filter(Boolean);
  }
  return violations;
}

/** bundle → bundle edges (deduplicated per file pair), with API-module flag. */
export function bundleGraph(list = edges()) {
  const cross = [];
  const fanOut = {};
  for (const e of list) {
    const a = classify(e.from);
    const b = classify(e.to);
    if (a.area !== "bundle" || b.area !== "bundle" || a.bundle === b.bundle) continue;
    cross.push({
      from: a.bundle,
      to: `${b.bundle}${b.api ? "/api" : ""}`,
      api: b.api,
      file: e.from,
    });
    fanOut[a.bundle] ??= new Set();
    fanOut[a.bundle].add(`${b.bundle}${b.api ? "/api" : ""}`);
  }
  return {
    cross,
    toApi: cross.filter((c) => c.api).length,
    violations: cross.filter((c) => !c.api),
    fanOut: Object.fromEntries(Object.entries(fanOut).map(([k, v]) => [k, [...v].sort()])),
  };
}
