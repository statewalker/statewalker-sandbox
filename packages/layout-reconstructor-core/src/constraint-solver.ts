import { Constraint, Expression, Operator, Solver, Strength, Variable } from "@lume/kiwi";
import type { GridTopology, SolvedTracks } from "./types.ts";

/**
 * Use the Cassowary constraint solver (@lume/kiwi) to compute
 * optimal track sizes for a given grid topology.
 *
 * Block positions and sizes become required constraints;
 * the solver finds track widths/heights that satisfy them.
 *
 * Returns null if the constraint system is unsatisfiable.
 */
export function solveTrackSizes(topology: GridTopology): SolvedTracks | null {
  const { rowLines, colLines, spans } = topology;
  const numColTracks = colLines.length - 1;
  const numRowTracks = rowLines.length - 1;

  if (numColTracks <= 0 || numRowTracks <= 0) return null;

  try {
    const solver = new Solver();

    const trackW: Variable[] = Array.from(
      { length: numColTracks },
      (_, i) => new Variable(`col_${i}`),
    );
    const trackH: Variable[] = Array.from(
      { length: numRowTracks },
      (_, i) => new Variable(`row_${i}`),
    );

    // Non-negative: variable >= 0
    for (const v of [...trackW, ...trackH]) {
      solver.addConstraint(
        new Constraint(new Expression(v), Operator.Ge, new Expression(0), Strength.required),
      );
    }

    // Suggest expected track sizes via edit variables
    for (let i = 0; i < numColTracks; i++) {
      const expected = colLines[i + 1] - colLines[i];
      solver.addEditVariable(trackW[i], Strength.strong);
      solver.suggestValue(trackW[i], expected);
    }
    for (let i = 0; i < numRowTracks; i++) {
      const expected = rowLines[i + 1] - rowLines[i];
      solver.addEditVariable(trackH[i], Strength.strong);
      solver.suggestValue(trackH[i], expected);
    }

    // Block width: sum(trackW[c1..c2]) == blockWidth
    for (const span of spans) {
      const blockWidth = colLines[span.colEnd + 1] - colLines[span.colStart];
      const expr = sumVariables(trackW, span.colStart, span.colEnd);
      solver.addConstraint(
        new Constraint(expr, Operator.Eq, new Expression(blockWidth), Strength.required),
      );

      // Block height: sum(trackH[r1..r2]) == blockHeight
      const blockHeight = rowLines[span.rowEnd + 1] - rowLines[span.rowStart];
      const hExpr = sumVariables(trackH, span.rowStart, span.rowEnd);
      solver.addConstraint(
        new Constraint(hExpr, Operator.Eq, new Expression(blockHeight), Strength.required),
      );

      // Block left position: sum(trackW[0..c1-1]) == blockLeft
      if (span.colStart > 0) {
        const blockLeft = colLines[span.colStart] - colLines[0];
        const posExpr = sumVariables(trackW, 0, span.colStart - 1);
        solver.addConstraint(
          new Constraint(posExpr, Operator.Eq, new Expression(blockLeft), Strength.required),
        );
      }

      // Block top position: sum(trackH[0..r1-1]) == blockTop
      if (span.rowStart > 0) {
        const blockTop = rowLines[span.rowStart] - rowLines[0];
        const posExpr = sumVariables(trackH, 0, span.rowStart - 1);
        solver.addConstraint(
          new Constraint(posExpr, Operator.Eq, new Expression(blockTop), Strength.required),
        );
      }
    }

    solver.updateVariables();

    const trackWidths = trackW.map((v) => v.value());
    const trackHeights = trackH.map((v) => v.value());

    // Compute error
    let error = 0;
    for (let i = 0; i < numColTracks; i++) {
      error += Math.abs(trackWidths[i] - (colLines[i + 1] - colLines[i]));
    }
    for (let i = 0; i < numRowTracks; i++) {
      error += Math.abs(trackHeights[i] - (rowLines[i + 1] - rowLines[i]));
    }

    return { trackWidths, trackHeights, error };
  } catch {
    // Unsatisfiable constraint system
    return null;
  }
}

/**
 * Build an Expression that sums variables[from..to] (inclusive).
 */
function sumVariables(vars: Variable[], from: number, to: number): Expression {
  let expr = new Expression(vars[from]);
  for (let i = from + 1; i <= to; i++) {
    expr = expr.plus(new Expression(vars[i]));
  }
  return expr;
}

/**
 * Detect proportional relationships between track sizes.
 * Returns groups of track indices that have the same or proportional sizes.
 *
 * Example: tracks [200, 200, 400] → groups [[0,1], [2]] with ratios [1, 2]
 */
export function detectProportionalTracks(
  sizes: number[],
  tolerance: number,
): { groups: number[][]; ratios: number[] } {
  if (sizes.length === 0) return { groups: [], ratios: [] };

  const nonZero = sizes.filter((s) => s > tolerance);
  if (nonZero.length === 0) {
    return {
      groups: [sizes.map((_, i) => i)],
      ratios: [0],
    };
  }

  const baseUnit = Math.min(...nonZero);

  const ratioMap = new Map<number, number[]>();
  for (let i = 0; i < sizes.length; i++) {
    const rawRatio = sizes[i] / baseUnit;
    const snappedRatio = Math.round(rawRatio * 2) / 2;
    const ratio = snappedRatio <= 0 ? 0 : snappedRatio;

    let found = false;
    for (const [existingRatio, indices] of ratioMap) {
      if (Math.abs(existingRatio - ratio) < tolerance / baseUnit) {
        indices.push(i);
        found = true;
        break;
      }
    }
    if (!found) {
      ratioMap.set(ratio, [i]);
    }
  }

  const groups: number[][] = [];
  const ratios: number[] = [];
  for (const [ratio, indices] of ratioMap) {
    groups.push(indices);
    ratios.push(ratio);
  }

  return { groups, ratios };
}
