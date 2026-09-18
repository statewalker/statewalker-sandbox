/**
 * LOC as §13 defines it: non-blank, non-comment lines of .ts/.tsx. Tests counted separately.
 * Usage: node scripts/loc.mjs [path…]   (default: per bundle, kernel, app files, tests)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP } from "./graph.mjs";

function files(p) {
  if (statSync(p).isFile()) return /\.(ts|tsx|mjs)$/.test(p) ? [p] : [];
  return readdirSync(p).flatMap((n) => files(join(p, n)));
}
export function loc(path) {
  let n = 0;
  let inBlock = false;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    if (line.startsWith("/*")) {
      const end = line.indexOf("*/");
      if (end < 0) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + 2).trim();
    }
    if (line === "" || line.startsWith("//")) continue;
    n++;
  }
  return n;
}
const count = (p) => {
  const fs = files(p);
  return { files: fs.length, loc: fs.reduce((s, f) => s + loc(f), 0) };
};

const args = process.argv.slice(2);
if (args.length) {
  for (const a of args) console.log(`${a}: ${JSON.stringify(count(join(APP, a)))}`);
} else {
  const rows = [];
  for (const b of readdirSync(join(APP, "src/bundles")).sort())
    rows.push([`bundles/${b}`, count(join(APP, "src/bundles", b))]);
  rows.push(["kernel", count(join(APP, "src/kernel"))]);
  const appFiles = ["features.ts", "features.react.ts", "main.tsx", "apps"].map((f) =>
    count(join(APP, "src", f)),
  );
  rows.push([
    "features + apps + main",
    appFiles.reduce((a, b) => ({ files: a.files + b.files, loc: a.loc + b.loc })),
  ]);
  const src = count(join(APP, "src"));
  const tests = count(join(APP, "tests"));
  for (const [name, c] of rows)
    console.log(
      `${name.padEnd(34)} ${String(c.files).padStart(3)} files ${String(c.loc).padStart(5)} LOC`,
    );
  console.log(
    `${"src total".padEnd(34)} ${String(src.files).padStart(3)} files ${String(src.loc).padStart(5)} LOC`,
  );
  console.log(
    `${"tests total".padEnd(34)} ${String(tests.files).padStart(3)} files ${String(tests.loc).padStart(5)} LOC`,
  );
}
