/**
 * 07 — `.access` as a walked tree: deny by default, explainable decisions.
 */

import { type AccessNode, withAccessTree } from "../lib/access-tree.ts";
import { heading } from "../lib/nodes.ts";

heading("07 — .access walked root → leaf, deny by default");

const tree: AccessNode[] = [
  { path: "" }, // root: no grants = deny
  { path: "/pub", allow: [{ mesh: "H", roles: [] }] }, // any member of H
  { path: "/reports", allow: [{ mesh: "H", roles: ["std:reader"] }] },
  { path: "/reports/private", deny: [{ mesh: "H", roles: ["std:reader"] }] },
  { path: "/reports/private/board", allow: [{ mesh: "H", roles: ["std:admin"] }] },
];

const resolve = withAccessTree(tree);

const alice = { mesh: "H", roles: ["std:reader"] };
const root = { mesh: "H", roles: ["std:reader", "std:admin"] };
const outsider = { mesh: "G", roles: ["std:admin"] }; // admin — but of another mesh

const cases: Array<[string, typeof alice, string, boolean]> = [
  ["/pub/logo.png", alice, "alice", true],
  ["/reports/q3", alice, "alice", true],
  ["/reports/private/notes", alice, "alice", false],
  ["/reports/private/board/minutes", alice, "alice", false],
  ["/reports/private/board/minutes", root, "root", true],
  ["/pub/logo.png", outsider, "outsider", false],
  ["/unlisted", alice, "alice", false],
];

let failures = 0;
for (const [path, caller, who, expected] of cases) {
  const d = resolve(path, caller);
  const ok = d.allowed === expected;
  if (!ok) failures += 1;
  const verdict = d.allowed ? "\x1b[32mallow\x1b[0m" : "\x1b[31mdeny \x1b[0m";
  console.log(
    `  ${verdict} ${who.padEnd(8)} ${path.padEnd(30)} decided at ${d.decidedAt.padEnd(24)} ${d.reason}${ok ? "" : "  \x1b[31m<-- UNEXPECTED\x1b[0m"}`,
  );
}

console.log(
  "\nWhy a refusal can be traced — the walk for alice on /reports/private/board/minutes:",
);
for (const line of resolve("/reports/private/board/minutes", alice).trace) {
  console.log(`  ${line}`);
}

// A malformed policy must fail loudly at construction, not silently at runtime.
let threw = "";
try {
  withAccessTree([{ path: "pub", allow: [{ mesh: "H", roles: [] }] }]);
} catch (err) {
  threw = (err as Error).message;
}
console.log("\nA malformed tree refuses to start rather than denying everyone silently:");
console.log(
  threw
    ? threw
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    : "  \x1b[31m✗ it started anyway\x1b[0m",
);

const ok = failures === 0 && threw.length > 0;
console.log(
  ok
    ? "\n\x1b[32m✓ 7 decisions correct, outsider's admin role in another mesh bought nothing, bad tree rejected\x1b[0m"
    : `\n\x1b[31m✗ ${failures} wrong decision(s)\x1b[0m`,
);
process.exit(ok ? 0 : 1);
