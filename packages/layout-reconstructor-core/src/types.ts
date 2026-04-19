/**
 * Input: a named block with absolute position on a normalized grid.
 * Positions are in "pixels" on a normalized grid (e.g., max side = 4096).
 */
export type InputBlock = {
  label: string;
  top: number;
  left: number;
  width: number;
  height: number;
};

/**
 * A size expression with value and unit, matching layout-builder format.
 * Example: { value: 150, unit: "px" } or { value: 1, unit: "fr" }
 */
export type SizeExpression = {
  value: number;
  unit: string;
};

/**
 * The output grid config, compatible with the layout-builder notebook.
 */
export type GridConfig = {
  rows: SizeExpression[];
  columns: SizeExpression[];
  areas: string[][];
  children?: Record<string, GridConfig>;
};

/**
 * Internal representation of a block's grid cell assignment.
 */
export type CellSpan = {
  label: string;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
};

/**
 * A candidate grid topology: grid line positions + block-to-cell assignments.
 */
export type GridTopology = {
  rowLines: number[];
  colLines: number[];
  spans: CellSpan[];
};

/**
 * Result of constraint solving: track sizes for a validated topology.
 */
export type SolvedTracks = {
  trackWidths: number[];
  trackHeights: number[];
  error: number;
};

/**
 * A containment tree node: a block that may contain child blocks.
 */
export type ContainmentNode = {
  block: InputBlock;
  children: ContainmentNode[];
};

/**
 * Options for the reconstruction pipeline.
 */
export type ReconstructOptions = {
  /** Tolerance for snapping edges (in grid units). Default: 20 */
  snapTolerance?: number;
  /** Whether to attempt proportional (fr) simplification. Default: true */
  discoverFractions?: boolean;
  /** Tolerance for considering sizes proportional (0..1 ratio). Default: 0.05 */
  fractionTolerance?: number;
  /** Container width (grid units). Default: inferred from blocks */
  containerWidth?: number;
  /** Container height (grid units). Default: inferred from blocks */
  containerHeight?: number;
};
