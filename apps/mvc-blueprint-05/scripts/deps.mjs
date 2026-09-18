/** Dependency-graph report (§13.3): cross-bundle edges, edges to API modules, violations, fan-out. */
import { bundleGraph } from "./graph.mjs";

const g = bundleGraph();
console.log(
  `cross-bundle edges: ${g.cross.length}; to API modules: ${g.toApi}; violations: ${g.violations.length}`,
);
for (const v of g.violations) console.log(`  VIOLATION ${v.file} → ${v.to}`);
console.log("fan-out (distinct modules per bundle):");
for (const [bundle, targets] of Object.entries(g.fanOut).sort()) {
  console.log(`  ${bundle.padEnd(24)} ${targets.length}  ${targets.join(", ")}`);
}
