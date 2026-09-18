/** LOC report: non-blank, non-comment lines of .ts/.tsx, per unit; tests separately. `pnpm loc [dir]`. */
import { sources, unitOf } from "./graph.js";

const count = (code: string) => code.split("\n").filter((l) => l.trim() !== "").length;
const arg = process.argv[2];
if (arg) {
  const files = sources(arg);
  console.log(
    `${arg}: ${files.reduce((n, s) => n + count(s.code), 0)} LOC in ${files.length} files`,
  );
  for (const s of files) console.log(`  ${s.file}: ${count(s.code)}`);
} else {
  const per: Record<string, { loc: number; files: number }> = {};
  for (const s of sources("src")) {
    const u = unitOf(s.file);
    const e = (per[u] ??= { loc: 0, files: 0 });
    e.loc += count(s.code);
    e.files++;
  }
  let total = 0;
  for (const [u, e] of Object.entries(per).sort()) {
    total += e.loc;
    console.log(`${u.padEnd(28)} ${String(e.loc).padStart(5)} LOC  ${e.files} files`);
  }
  console.log(`${"src total".padEnd(28)} ${String(total).padStart(5)}`);
  const tests = sources("tests");
  console.log(
    `${"tests".padEnd(28)} ${String(tests.reduce((n, s) => n + count(s.code), 0)).padStart(5)} LOC  ${tests.length} files`,
  );
}
