export {
  detectProportionalTracks,
  solveTrackSizes,
} from "./constraint-solver.ts";
export { buildAreasMatrix, computeTrackSizes } from "./grid-builder.ts";
export { buildContainmentTree, snapEdges } from "./preprocess.ts";
export { reconstructGrid } from "./reconstruct.ts";
export { simplifyGridConfig, simplifyTrackSizes } from "./simplify.ts";
export {
  buildTopologyByEdgeProjection,
  mergeEmptyTracks,
  suggestColumnCounts,
} from "./topology.ts";
export type {
  CellSpan,
  ContainmentNode,
  GridConfig,
  GridTopology,
  InputBlock,
  ReconstructOptions,
  SizeExpression,
  SolvedTracks,
} from "./types.ts";
