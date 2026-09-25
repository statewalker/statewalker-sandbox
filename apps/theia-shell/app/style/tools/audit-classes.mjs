// Lists the utilities in lib/app.css whose class name Theia or Monaco also put
// on their own DOM, where the utility would apply too. Run after the app's
// `pnpm build` (it reads app/src-gen for the Theia packages the app loads):
//   node tools/audit-classes.mjs
// A name found here either means the same thing in Theia (harmless) or belongs
// in the `@source not inline(...)` list in src/app.css.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const css = readFileSync(new URL("../lib/app.css", import.meta.url), "utf8");
const names = [...new Set([...css.matchAll(/^\.([a-z][a-z0-9-]*)[ ,{]/gm)].map((m) => m[1]))];

const require = createRequire(import.meta.url);
const root = (pkg) => dirname(require.resolve(`${pkg}/package.json`));
// Every Theia package the app's generated frontend loads, plus Monaco.
const frontend = readFileSync(new URL("../../src-gen/frontend/index.js", import.meta.url), "utf8");
const packages = [
  ...new Set([...frontend.matchAll(/'(@theia\/[a-z-]+)\/lib\//g)].map((m) => m[1])),
];
const roots = [
  ...packages.map((p) => join(root(p), "lib", "browser")),
  join(root("@theia/monaco-editor-core"), "esm"),
];

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith(".js")) yield path;
  }
}

const sources = roots.flatMap((dir) => [...files(dir)].map((f) => readFileSync(f, "utf8")));
const q = "['\"`]";
const hits = names.filter((name) => {
  const token = `(?:[^'"\`]* )?${name}(?: [^'"\`]*)?`;
  const re = new RegExp(
    `className\\s*[:=]\\s*${q}${token}${q}|classList\\.(?:add|toggle)\\([^)]*${q}${name}${q}`,
  );
  return sources.some((s) => re.test(s));
});

console.log(
  `${names.length} utilities, ${packages.length} Theia packages; used as class names by Theia/Monaco: ${hits.join(", ") || "none"}`,
);
