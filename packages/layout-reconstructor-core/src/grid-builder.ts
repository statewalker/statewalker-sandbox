import type { CellSpan, GridTopology } from "./types.ts";

/**
 * Build a 2D areas matrix from a grid topology.
 * Each cell contains the label of the block that covers it, or "." for empty.
 *
 * Returns null if any named area doesn't form a valid rectangle
 * (which is required by CSS Grid and the layout-builder format).
 */
export function buildAreasMatrix(topology: GridTopology): string[][] | null {
  const numRows = topology.rowLines.length - 1;
  const numCols = topology.colLines.length - 1;

  // Initialize with empty cells
  const matrix: string[][] = Array.from({ length: numRows }, () =>
    Array.from({ length: numCols }, () => "."),
  );

  // Fill cells with block labels
  for (const span of topology.spans) {
    for (let r = span.rowStart; r <= span.rowEnd; r++) {
      for (let c = span.colStart; c <= span.colEnd; c++) {
        if (r >= numRows || c >= numCols) continue;
        if (matrix[r][c] !== "." && matrix[r][c] !== span.label) {
          // Overlap detected — two blocks claim the same cell
          return null;
        }
        matrix[r][c] = span.label;
      }
    }
  }

  // Validate: each named area must form a rectangle
  if (!validateRectangularAreas(matrix)) {
    return null;
  }

  return matrix;
}

/**
 * Validate that every named area in the matrix forms a contiguous rectangle.
 */
function validateRectangularAreas(matrix: string[][]): boolean {
  const bounds = new Map<
    string,
    { minRow: number; maxRow: number; minCol: number; maxCol: number }
  >();

  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      const label = matrix[r][c];
      if (label === ".") continue;
      const b = bounds.get(label);
      if (b) {
        b.minRow = Math.min(b.minRow, r);
        b.maxRow = Math.max(b.maxRow, r);
        b.minCol = Math.min(b.minCol, c);
        b.maxCol = Math.max(b.maxCol, c);
      } else {
        bounds.set(label, { minRow: r, maxRow: r, minCol: c, maxCol: c });
      }
    }
  }

  // Check that every cell within the bounding box belongs to the area
  for (const [label, b] of bounds) {
    for (let r = b.minRow; r <= b.maxRow; r++) {
      for (let c = b.minCol; c <= b.maxCol; c++) {
        if (matrix[r][c] !== label) {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Compute track sizes (widths/heights) from grid line positions.
 */
export function computeTrackSizes(lines: number[]): number[] {
  const sizes: number[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    sizes.push(lines[i + 1] - lines[i]);
  }
  return sizes;
}

/**
 * Extract unique area labels from a grid topology (excluding ".").
 */
export function extractAreaLabels(spans: CellSpan[]): string[] {
  return [...new Set(spans.map((s) => s.label))];
}
