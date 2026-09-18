// LOC (§13): non-blank, non-comment lines of .ts/.tsx, per area. Tests counted separately.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loc, ROOT, walk } from "./graph.mjs";

const row = (name, files) =>
  console.log(
    `${name.padEnd(28)} ${String(files.length).padStart(3)} files ${String(loc(files)).padStart(6)} LOC`,
  );
for (const area of ["kernel", "kit"]) row(`src/${area}`, walk(join(ROOT, "src", area)));
const bundles = readdirSync(join(ROOT, "src/bundles")).sort();
let total = [];
for (const b of bundles) {
  const files = walk(join(ROOT, "src/bundles", b));
  total = total.concat(files);
  row(`bundles/${b}`, files);
}
row("bundles (all)", total);
row("src (all)", walk(join(ROOT, "src")));
row("tests", walk(join(ROOT, "tests")));
const hello = ["hello", "hello.ui.react"].flatMap((b) => walk(join(ROOT, "src/bundles", b)));
row("hello (logic+api+renderer)", hello);
