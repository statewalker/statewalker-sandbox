/**
 * 09 — Roles describe people; capabilities are what code checks.
 */
import { heading } from "../lib/nodes.ts";
import { capabilitiesFor, defineVocabulary } from "../lib/vocabulary.ts";

heading("09 — role → capability, unioned, namespaced, unknown = nothing");

// One document per node, mesh-independent. `H/` and `G/` are different keys,
// so there is nothing to reconcile and no per-mesh redefinition.
const vocab = defineVocabulary({
  "std:reader": ["files:read"],
  "std:editor": ["files:read", "files:write"],
  "std:admin": ["files:read", "files:write", "members:manage"],
  "H/photo-curator": ["images:share", "files:read"],
  "G/editor": ["files:write"],
});

const show = (label: string, roles: string[]) => {
  const r = capabilitiesFor(vocab, roles);
  console.log(`  ${label.padEnd(34)} roles=${JSON.stringify(roles)}`);
  console.log(`  ${" ".repeat(34)} caps =${JSON.stringify(r.capabilities)}`);
  if (r.unknown.length > 0) {
    console.log(`  ${" ".repeat(34)} \x1b[33munknown (granted nothing): ${JSON.stringify(r.unknown)}\x1b[0m`);
  }
  return r;
};

console.log("The union is additive — two roles give the sum, never a subtraction:\n");
const a = show("editor alone", ["std:editor"]);
const b = show("curator alone", ["H/photo-curator"]);
const both = show("editor + curator", ["std:editor", "H/photo-curator"]);

const isUnion = [...new Set([...a.capabilities, ...b.capabilities])].sort().join() === both.capabilities.join();
console.log(`\n  union check: ${isUnion ? "\x1b[32m✓ exactly the sum of the parts\x1b[0m" : "\x1b[31m✗ not a union\x1b[0m"}`);

console.log("\nAn unknown role grants nothing — never a fallback:\n");
const unknown = show("editor + a role we don't know", ["std:editor", "H/not-in-our-vocabulary"]);
const noFallback =
  unknown.capabilities.join() === a.capabilities.join() && unknown.unknown.length === 1;
console.log(`\n  ${noFallback ? "\x1b[32m✓ the unknown role added no capability\x1b[0m" : "\x1b[31m✗ over-granted\x1b[0m"}`);

console.log("\nNamespacing keeps two meshes' same-named roles distinct:\n");
const hEditor = show("std:editor (reserved list)", ["std:editor"]);
const gEditor = show("G/editor (mesh G's own)", ["G/editor"]);
const distinct = hEditor.capabilities.join() !== gEditor.capabilities.join();
console.log(`\n  ${distinct ? "\x1b[32m✓ H's editor and G's editor are different keys\x1b[0m" : "\x1b[31m✗ collided\x1b[0m"}`);

// Trust and vocabulary are separate layers: this mapping is global, but it
// grants nothing on its own — a .access policy still names which mesh is
// honoured for a resource (see prototype 07).
let threw = false;
try {
  defineVocabulary({ editor: ["files:write"] });
} catch {
  threw = true;
}
console.log(
  `\nAn unnamespaced role is rejected at construction: ${threw ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ accepted\x1b[0m"}`,
);

const ok = isUnion && noFallback && distinct && threw;
console.log(
  ok
    ? "\n\x1b[32m✓ additive union, no fallback grant, namespaces distinct, bad names rejected\x1b[0m"
    : "\n\x1b[31m✗ vocabulary rules violated\x1b[0m",
);
process.exit(ok ? 0 : 1);
