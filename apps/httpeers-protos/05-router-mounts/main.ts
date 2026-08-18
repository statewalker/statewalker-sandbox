/**
 * 05 — Mount resolution: longest prefix, on segment boundaries.
 *
 * The truth table below is the point. `/files` must not swallow
 * `/filesystem`, a deeper mount must win over a shallower one regardless of
 * registration order, and `/` must be reachable as a catch-all without
 * becoming a catch-everything.
 *
 * This runs in-process — no network — because it is a pure routing property.
 * The networked demos are 01/02/03/06.
 */
import { heading } from "../lib/nodes.ts";
import { type Mount, matchMount } from "../lib/router.ts";

heading("05 — mount resolution truth table");

const named = (name: string): Mount => ({
  prefix: name,
  handler: async () => new Response(name),
});

// Deliberately registered shallow-first, so "longest wins" cannot be an
// accident of ordering.
const mounts = [named("/"), named("/files"), named("/files/public"), named("/filesystem")];

const cases: Array<[string, string]> = [
  ["/files", "/files"],
  ["/files/", "/files"],
  ["/files/a.txt", "/files"],
  ["/files/public", "/files/public"],
  ["/files/public/x", "/files/public"],
  ["/filesystem", "/filesystem"],
  ["/filesystem/deep/er", "/filesystem"],
  ["/", "/"],
  ["/unmatched", "/"],
];

let failures = 0;
console.log("  request              -> mount        expected");
for (const [path, expected] of cases) {
  const got = matchMount(mounts, path)?.prefix ?? "(none)";
  const ok = got === expected;
  if (!ok) failures += 1;
  console.log(
    `  ${path.padEnd(20)} -> ${got.padEnd(12)} ${expected.padEnd(12)} ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}`,
  );
}

// The boundary rule is the one worth stating out loud.
const swallowed = matchMount(mounts, "/filesystem")?.prefix === "/files";
console.log(
  `\n/filesystem resolved to ${matchMount(mounts, "/filesystem")?.prefix} — ` +
    (swallowed
      ? "\x1b[31m✗ /files swallowed a longer sibling name\x1b[0m"
      : "\x1b[32m✓ a shared prefix did not capture a different mount\x1b[0m"),
);

console.log(
  failures === 0
    ? "\n\x1b[32m✓ all 9 routing cases resolved as specified\x1b[0m"
    : `\n\x1b[31m✗ ${failures} case(s) wrong\x1b[0m`,
);
process.exit(failures === 0 && !swallowed ? 0 : 1);
