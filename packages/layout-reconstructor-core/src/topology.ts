import type { CellSpan, GridTopology, InputBlock } from "./types.ts";

/**
 * Generate a grid topology by projecting all block edges onto X and Y axes.
 * This is the "sweep lines" approach — it always produces a valid topology
 * but may have more rows/columns than necessary.
 */
export function buildTopologyByEdgeProjection(
  blocks: InputBlock[],
  containerWidth: number,
  containerHeight: number,
): GridTopology {
  const xEdges = new Set<number>([0, containerWidth]);
  const yEdges = new Set<number>([0, containerHeight]);

  for (const b of blocks) {
    xEdges.add(b.left);
    xEdges.add(b.left + b.width);
    yEdges.add(b.top);
    yEdges.add(b.top + b.height);
  }

  const colLines = [...xEdges].sort((a, b) => a - b);
  const rowLines = [...yEdges].sort((a, b) => a - b);

  const spans = blocks.map((b) => assignToGrid(b, rowLines, colLines));

  return { rowLines, colLines, spans };
}

/**
 * Assign a block to grid cells based on its position relative to grid lines.
 */
function assignToGrid(block: InputBlock, rowLines: number[], colLines: number[]): CellSpan {
  const colStart = findLineIndex(colLines, block.left);
  const colEnd = findLineIndex(colLines, block.left + block.width) - 1;
  const rowStart = findLineIndex(rowLines, block.top);
  const rowEnd = findLineIndex(rowLines, block.top + block.height) - 1;

  return {
    label: block.label,
    rowStart,
    rowEnd,
    colStart,
    colEnd,
  };
}

/**
 * Find the index of a value in a sorted array of grid lines.
 */
function findLineIndex(lines: number[], value: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === value) return i;
  }
  // Closest match fallback
  let best = 0;
  let bestDist = Math.abs(lines[0] - value);
  for (let i = 1; i < lines.length; i++) {
    const dist = Math.abs(lines[i] - value);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Analyze block size sums to suggest possible column/row counts.
 * Returns candidate column counts sorted by likelihood.
 */
export function suggestColumnCounts(
  blocks: InputBlock[],
  containerWidth: number,
  tolerance: number,
): number[] {
  const widths = blocks.map((b) => b.width);
  const counts = new Set<number>();

  // Check how many blocks fit side-by-side
  for (let n = 1; n <= blocks.length; n++) {
    // Find groups of blocks whose widths sum to ~containerWidth
    const groups = findWidthGroups(widths, containerWidth, n, tolerance);
    if (groups.length > 0) {
      counts.add(n);
    }
  }

  // Also add count from unique left positions (distinct columns)
  const uniqueLefts = new Set(blocks.map((b) => b.left));
  counts.add(uniqueLefts.size);

  return [...counts].sort((a, b) => a - b);
}

/**
 * Find groups of N widths that sum to approximately the target.
 */
function findWidthGroups(
  widths: number[],
  target: number,
  n: number,
  tolerance: number,
): number[][] {
  const results: number[][] = [];
  if (n === 1) {
    for (const w of widths) {
      if (Math.abs(w - target) <= tolerance) {
        results.push([w]);
      }
    }
    return results;
  }

  // Simple combinatorial check for small n
  const sorted = [...widths].sort((a, b) => b - a);
  findCombinations(sorted, 0, n, target, tolerance, [], results);
  return results;
}

function findCombinations(
  widths: number[],
  start: number,
  remaining: number,
  target: number,
  tolerance: number,
  current: number[],
  results: number[][],
): void {
  if (remaining === 0) {
    if (Math.abs(target) <= tolerance) {
      results.push([...current]);
    }
    return;
  }
  for (let i = start; i < widths.length; i++) {
    if (widths[i] > target + tolerance) continue;
    current.push(widths[i]);
    findCombinations(widths, i + 1, remaining - 1, target - widths[i], tolerance, current, results);
    current.pop();
  }
}

/**
 * Attempt to merge thin empty tracks from a topology,
 * producing a more compact grid.
 */
export function mergeEmptyTracks(topology: GridTopology, minTrackSize: number): GridTopology {
  const { rowLines, colLines, spans } = topology;

  const usedRows = new Set<number>();
  const usedCols = new Set<number>();
  for (const s of spans) {
    for (let r = s.rowStart; r <= s.rowEnd; r++) usedRows.add(r);
    for (let c = s.colStart; c <= s.colEnd; c++) usedCols.add(c);
  }

  // Find mergeable row tracks (empty and thin)
  const keepRowLines = filterLines(rowLines, usedRows, minTrackSize);
  const keepColLines = filterLines(colLines, usedCols, minTrackSize);

  // Remap spans to new indices
  const rowMap = buildLineMapping(rowLines, keepRowLines);
  const colMap = buildLineMapping(colLines, keepColLines);

  const newSpans = spans.map((s) => ({
    label: s.label,
    rowStart: rowMap.get(rowLines[s.rowStart]) ?? s.rowStart,
    rowEnd: rowMap.get(rowLines[s.rowEnd + 1])
      ? (rowMap.get(rowLines[s.rowEnd + 1]) ?? s.rowEnd + 1) - 1
      : s.rowEnd,
    colStart: colMap.get(colLines[s.colStart]) ?? s.colStart,
    colEnd: colMap.get(colLines[s.colEnd + 1])
      ? (colMap.get(colLines[s.colEnd + 1]) ?? s.colEnd + 1) - 1
      : s.colEnd,
  }));

  return { rowLines: keepRowLines, colLines: keepColLines, spans: newSpans };
}

function filterLines(lines: number[], usedTracks: Set<number>, minSize: number): number[] {
  if (lines.length <= 2) return lines;
  const keep = [lines[0]];
  for (let i = 1; i < lines.length - 1; i++) {
    const trackBefore = i - 1;
    const trackAfter = i;
    const sizeBefore = lines[i] - lines[i - 1];
    const sizeAfter = i + 1 < lines.length ? lines[i + 1] - lines[i] : Infinity;

    // Keep if any adjacent track is used or if both tracks are non-thin
    if (
      usedTracks.has(trackBefore) ||
      usedTracks.has(trackAfter) ||
      (sizeBefore > minSize && sizeAfter > minSize)
    ) {
      keep.push(lines[i]);
    }
  }
  keep.push(lines[lines.length - 1]);
  return keep;
}

function buildLineMapping(oldLines: number[], newLines: number[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < newLines.length; i++) {
    map.set(newLines[i], i);
  }
  // Map old line values to new indices
  for (const oldVal of oldLines) {
    if (!map.has(oldVal)) {
      // Find closest new line
      let best = 0;
      let bestDist = Math.abs(newLines[0] - oldVal);
      for (let i = 1; i < newLines.length; i++) {
        const dist = Math.abs(newLines[i] - oldVal);
        if (dist < bestDist) {
          best = i;
          bestDist = dist;
        }
      }
      map.set(oldVal, best);
    }
  }
  return map;
}
