#!/usr/bin/env node
// LOC per module: non-blank, non-comment lines of .ts/.tsx (ARCHITECTURE §13). Tests counted apart.
// Usage: node scripts/loc.mjs [path-prefix …]   e.g. node scripts/loc.mjs src/bundles/hello
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** Non-blank, non-comment lines; string literals are kept (a "//" inside one is not a comment). */
export function loc(text) {
  const code = text.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_m, literal) => literal ?? "",
  );
  return code.split("\n").filter((line) => line.trim() !== "").length;
}

function moduleOf(file) {
  const m =
    /^src\/bundles\/([^/]+\/api(?:\/(?:dom|solid|spec))?)\//.exec(file) ??
    /^src\/bundles\/([^/]+)\//.exec(file) ??
    /^src\/(kits\/[^/]+)\//.exec(file) ??
    /^src\/(kernel)\//.exec(file) ??
    /^(tests)\//.exec(file);
  return m ? m[1] : file.startsWith("src/") ? "app (features, apps, main)" : "other";
}

const filters = process.argv.slice(2);
const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "tests"))]
  .map((p) => relative(ROOT, p))
  .filter((f) => filters.length === 0 || filters.some((prefix) => f.startsWith(prefix)));

const rows = new Map();
for (const file of files) {
  const key = moduleOf(file);
  const row = rows.get(key) ?? { files: 0, loc: 0 };
  row.files++;
  row.loc += loc(readFileSync(join(ROOT, file), "utf8"));
  rows.set(key, row);
}
const kind = (m) =>
  m === "tests"
    ? "tests"
    : m === "kernel"
      ? "kernel"
      : m.startsWith("kits/")
        ? "kit"
        : /\/api/.test(m)
          ? "api"
          : /\.ui\.|^ui\.|^shell\.(dom|solid|test)/.test(m)
            ? "ui"
            : m.startsWith("app")
              ? "app"
              : "logic";
const sorted = [...rows].sort(([a], [b]) => kind(a).localeCompare(kind(b)) || a.localeCompare(b));
const totals = new Map();
console.log(
  `${"module".padEnd(30)} ${"kind".padEnd(6)} ${"files".padStart(5)} ${"LOC".padStart(6)}`,
);
for (const [m, r] of sorted) {
  console.log(
    `${m.padEnd(30)} ${kind(m).padEnd(6)} ${String(r.files).padStart(5)} ${String(r.loc).padStart(6)}`,
  );
  const t = totals.get(kind(m)) ?? { files: 0, loc: 0 };
  t.files += r.files;
  t.loc += r.loc;
  totals.set(kind(m), t);
}
console.log("—".repeat(50));
for (const [k, t] of totals)
  console.log(
    `${("total " + k).padEnd(37)} ${String(t.files).padStart(5)} ${String(t.loc).padStart(6)}`,
  );
