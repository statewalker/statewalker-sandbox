import { solveTrackSizes } from "./constraint-solver.ts";
import { buildAreasMatrix, computeTrackSizes } from "./grid-builder.ts";
import { buildContainmentTree, snapEdges } from "./preprocess.ts";
import { simplifyGridConfig } from "./simplify.ts";
import { buildTopologyByEdgeProjection } from "./topology.ts";
import type { ContainmentNode, GridConfig, InputBlock, ReconstructOptions } from "./types.ts";

const DEFAULT_OPTIONS: Required<ReconstructOptions> = {
  snapTolerance: 20,
  discoverFractions: true,
  fractionTolerance: 0.05,
  containerWidth: 0,
  containerHeight: 0,
};

/**
 * Main pipeline: reconstruct a hierarchical grid config from absolute block positions.
 *
 * Pipeline:
 * 1. Preprocess — snap edges, detect containment
 * 2. Build topology — project edges to grid lines
 * 3. Solve constraints — validate topology and compute track sizes
 * 4. Build areas matrix — assign blocks to cells
 * 5. Simplify — discover fr units, merge thin tracks
 * 6. Recurse — process children
 */
export function reconstructGrid(
  blocks: InputBlock[],
  options: ReconstructOptions = {},
): GridConfig {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (blocks.length === 0) {
    return { rows: [], columns: [], areas: [] };
  }

  // Step 1: Snap edges
  const snapped = snapEdges(blocks, opts.snapTolerance);

  // Infer container bounds if not provided
  const containerWidth = opts.containerWidth || Math.max(...snapped.map((b) => b.left + b.width));
  const containerHeight = opts.containerHeight || Math.max(...snapped.map((b) => b.top + b.height));

  // Step 2: Detect containment hierarchy
  const tree = buildContainmentTree(snapped);

  // Step 3: Build grid from root-level blocks
  return buildGridFromNodes(tree, containerWidth, containerHeight, opts);
}

/**
 * Build a GridConfig from a set of containment tree nodes.
 */
function buildGridFromNodes(
  nodes: ContainmentNode[],
  containerWidth: number,
  containerHeight: number,
  opts: Required<ReconstructOptions>,
): GridConfig {
  // Extract just the direct blocks (not their children)
  const directBlocks = nodes.map((n) => n.block);

  // Build topology via edge projection
  const topology = buildTopologyByEdgeProjection(directBlocks, containerWidth, containerHeight);

  // Validate with constraint solver
  const solved = solveTrackSizes(topology);

  // Build areas matrix
  const areas = buildAreasMatrix(topology);
  if (!areas) {
    // Fallback: single-column layout if areas matrix is invalid
    return buildFallbackGrid(directBlocks, containerWidth, containerHeight);
  }

  // Compute track sizes (from grid lines or solver)
  const trackWidths = solved ? solved.trackWidths : computeTrackSizes(topology.colLines);
  const trackHeights = solved ? solved.trackHeights : computeTrackSizes(topology.rowLines);

  // Build initial config with px sizes
  const config: GridConfig = {
    rows: trackHeights.map((h) => ({ value: Math.round(h), unit: "px" })),
    columns: trackWidths.map((w) => ({ value: Math.round(w), unit: "px" })),
    areas,
  };

  // Recurse into children
  const children: Record<string, GridConfig> = {};
  for (const node of nodes) {
    if (node.children.length > 0) {
      const childConfig = buildGridFromNodes(
        node.children,
        node.block.width,
        node.block.height,
        opts,
      );
      children[node.block.label] = childConfig;
    }
  }
  if (Object.keys(children).length > 0) {
    config.children = children;
  }

  // Simplify: discover fr units
  return simplifyGridConfig(
    config,
    opts.fractionTolerance * containerWidth,
    opts.discoverFractions,
  );
}

/**
 * Fallback: create a simple single-column stacked layout
 * when the areas matrix fails validation.
 */
function buildFallbackGrid(
  blocks: InputBlock[],
  containerWidth: number,
  _containerHeight: number,
): GridConfig {
  const sorted = [...blocks].sort((a, b) => a.top - b.top);
  const rows = sorted.map((b) => ({
    value: Math.round(b.height),
    unit: "px",
  }));
  const columns = [{ value: Math.round(containerWidth), unit: "px" }];
  const areas = sorted.map((b) => [b.label]);

  return { rows, columns, areas };
}
