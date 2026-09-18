// Dependency-graph report (§13.3): cross-bundle edges, edges to API modules, violations, fan-out.
import { bundleOf, graph } from "./graph.mjs";

const edges = graph().filter(
  (e) => !e.external && e.to !== "kernel" && e.to !== "kit" && e.to !== "kit/react",
);
const cross = edges.filter((e) => bundleOf(e.from) !== bundleOf(e.to));
const toApi = cross.filter((e) => e.to.endsWith("/api"));
const violations = cross.filter((e) => !e.to.endsWith("/api"));
const fanOut = {};
for (const e of cross) (fanOut[bundleOf(e.from)] ??= new Set()).add(e.to);
console.log(`cross-bundle edges (import statements): ${cross.length}`);
console.log(`  to API modules: ${toApi.length}`);
console.log(`  violations: ${violations.length}`);
for (const v of violations) console.log(`    ${v.file} → ${v.spec}`);
console.log("fan-out (distinct API modules per bundle):");
for (const [b, set] of Object.entries(fanOut).sort())
  console.log(`  ${b.padEnd(24)} ${set.size}  ${[...set].sort().join(", ")}`);
