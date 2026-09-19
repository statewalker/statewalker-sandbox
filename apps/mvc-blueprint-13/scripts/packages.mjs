#!/usr/bin/env node
// D13: every kernel / kit / bundle folder under packages/ is a package with `exports`. This script
// (re)writes each package.json from the imports it finds, and the app's `link:` dependencies.
// `node scripts/packages.mjs --check` fails if any package.json is out of date (the boundary suite
// also checks that every import is declared).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const check = process.argv.includes("--check");
const app = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const external = { ...app.dependencies, ...app.devDependencies };

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });

export function listPackages() {
  const dirs = [join(ROOT, "packages/kernel")];
  for (const group of ["kits", "bundles"])
    for (const n of readdirSync(join(ROOT, "packages", group)).sort())
      dirs.push(join(ROOT, "packages", group, n));
  return dirs.map((dir) => {
    const base = relative(join(ROOT, "packages"), dir);
    const leaf = base.split("/").at(-1);
    const name =
      base === "kernel"
        ? "@p5/kernel"
        : base.startsWith("kits/")
          ? `@p5/kit-${leaf}`
          : `@p5/${leaf}`;
    return { dir, name };
  });
}

const entry = (dir) => ["index.ts", "index.tsx"].find((f) => existsSync(join(dir, f)));

function exportsOf(dir) {
  const out = {};
  const main = entry(dir);
  if (main) out["."] = `./${main}`;
  const visit = (sub) => {
    const d = join(dir, sub);
    if (!existsSync(d)) return;
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (!statSync(p).isDirectory()) continue;
      const e = entry(p);
      if (e && /^api/.test(join(sub, n))) out[`./${join(sub, n)}`] = `./${join(sub, n, e)}`;
      visit(join(sub, n));
    }
  };
  visit("");
  return out;
}

/** Bare specifiers imported by a package's files (value and type imports alike). */
export function importsOf(dir) {
  const specs = new Set();
  for (const f of walk(dir)) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"([^"./][^"]*)"/g)) specs.add(m[1]);
  }
  return specs;
}

const pkgOf = (spec) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

const packages = listPackages();
const byName = new Map(packages.map((p) => [p.name, p]));
let stale = 0;
for (const p of packages) {
  const deps = {};
  for (const spec of importsOf(p.dir)) {
    const name = pkgOf(spec);
    if (name === p.name) continue;
    if (byName.has(name)) deps[name] = `link:${relative(p.dir, byName.get(name).dir)}`;
    else if (name.startsWith("node:")) continue;
    else if (external[name]) deps[name] = external[name];
    else throw new Error(`${p.name}: imports ${spec}, which the app does not depend on`);
  }
  const json = {
    name: p.name,
    version: "0.0.0",
    private: true,
    type: "module",
    exports: exportsOf(p.dir),
    dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
  };
  const text = `${JSON.stringify(json, null, 2)}\n`;
  const file = join(p.dir, "package.json");
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (old !== text) {
    stale++;
    if (!check) writeFileSync(file, text);
  }
}
// The app links every package (pnpm `link:`), so `@p5/*` resolves through node_modules.
const links = Object.fromEntries(packages.map((p) => [p.name, `link:${relative(ROOT, p.dir)}`]));
const nextDeps = Object.fromEntries(
  Object.entries({
    ...Object.fromEntries(Object.entries(app.dependencies).filter(([k]) => !k.startsWith("@p5/"))),
    ...links,
  }).sort(([a], [b]) => a.localeCompare(b)),
);
if (JSON.stringify(nextDeps) !== JSON.stringify(app.dependencies)) {
  stale++;
  if (!check)
    writeFileSync(
      join(ROOT, "package.json"),
      `${JSON.stringify({ ...app, dependencies: nextDeps }, null, 2)}\n`,
    );
}
if (check && stale) {
  console.error(`${stale} package.json file(s) out of date; run node scripts/packages.mjs`);
  process.exit(1);
}
console.log(`${packages.length} packages${check ? " up to date" : ""}`);
