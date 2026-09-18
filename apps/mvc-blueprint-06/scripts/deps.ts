/** Prints the dependency-graph report: `pnpm deps`. */
import { graph, sources } from "./graph.js";

const g = graph(sources());
console.log(`bundles: ${g.bundles.length}`);
console.log(
  `cross-bundle edges: ${g.crossBundleEdges}, to API modules: ${g.toApi}, violations: ${g.violations.length}`,
);
for (const v of g.violations) console.log(`  VIOLATION ${v.from} → ${v.to} (${v.file})`);
console.log("fan-out (unique targets, kernel/kit included):");
for (const [b, targets] of Object.entries(g.fanOut).sort())
  console.log(`  ${b} (${targets.length}): ${targets.join(", ")}`);
