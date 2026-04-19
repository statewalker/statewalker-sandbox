import type { ContainmentNode, InputBlock } from "./types.ts";

/**
 * Snap block edges to nearby values within tolerance,
 * reducing noise from imprecise extraction.
 */
export function snapEdges(blocks: InputBlock[], tolerance: number): InputBlock[] {
  const xEdges: number[] = [];
  const yEdges: number[] = [];

  for (const b of blocks) {
    xEdges.push(b.left, b.left + b.width);
    yEdges.push(b.top, b.top + b.height);
  }

  const xSnapped = clusterValues(xEdges, tolerance);
  const ySnapped = clusterValues(yEdges, tolerance);

  return blocks.map((b) => {
    const left = snap(b.left, xSnapped);
    const top = snap(b.top, ySnapped);
    const right = snap(b.left + b.width, xSnapped);
    const bottom = snap(b.top + b.height, ySnapped);
    return {
      label: b.label,
      left,
      top,
      width: right - left,
      height: bottom - top,
    };
  });
}

/**
 * Cluster nearby values and return a map from original → cluster center.
 */
function clusterValues(values: number[], tolerance: number): Map<number, number> {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const clusters: number[][] = [];
  let current: number[] = [];

  for (const v of sorted) {
    if (current.length === 0 || v - current[current.length - 1] <= tolerance) {
      current.push(v);
    } else {
      clusters.push(current);
      current = [v];
    }
  }
  if (current.length > 0) clusters.push(current);

  const mapping = new Map<number, number>();
  for (const cluster of clusters) {
    const center = cluster.reduce((a, b) => a + b, 0) / cluster.length;
    const rounded = Math.round(center);
    for (const v of cluster) {
      mapping.set(v, rounded);
    }
  }
  return mapping;
}

function snap(value: number, mapping: Map<number, number>): number {
  return mapping.get(value) ?? value;
}

/**
 * Build a containment tree: blocks that fully contain other blocks
 * become parents. Returns root-level nodes (blocks not contained by any other).
 */
export function buildContainmentTree(blocks: InputBlock[]): ContainmentNode[] {
  const sorted = [...blocks].sort((a, b) => b.width * b.height - a.width * a.height);

  const nodes: ContainmentNode[] = sorted.map((block) => ({
    block,
    children: [],
  }));

  const roots: ContainmentNode[] = [];

  for (let i = 0; i < nodes.length; i++) {
    let placed = false;
    for (let j = 0; j < i; j++) {
      if (contains(nodes[j].block, nodes[i].block)) {
        insertIntoTree(nodes[j], nodes[i]);
        placed = true;
        break;
      }
    }
    if (!placed) {
      roots.push(nodes[i]);
    }
  }

  return roots;
}

/**
 * Insert a node into the deepest matching container in the subtree.
 */
function insertIntoTree(parent: ContainmentNode, child: ContainmentNode): void {
  for (const existing of parent.children) {
    if (contains(existing.block, child.block)) {
      insertIntoTree(existing, child);
      return;
    }
  }
  parent.children.push(child);
}

/**
 * Check if block `outer` fully contains block `inner`.
 */
function contains(outer: InputBlock, inner: InputBlock): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  );
}
