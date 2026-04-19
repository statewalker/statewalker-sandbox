import { detectProportionalTracks } from "./constraint-solver.ts";
import type { GridConfig, SizeExpression } from "./types.ts";

/**
 * Simplify track sizes by discovering proportional (fr) relationships.
 *
 * Converts absolute pixel sizes to a mix of:
 * - `fr` units for proportional tracks
 * - `px` units for fixed-size tracks that don't fit any ratio pattern
 */
export function simplifyTrackSizes(
  sizes: number[],
  tolerance: number,
  discoverFractions: boolean,
): SizeExpression[] {
  if (!discoverFractions) {
    return sizes.map((s) => ({ value: Math.round(s), unit: "px" }));
  }

  const { groups, ratios } = detectProportionalTracks(sizes, tolerance);

  // If all tracks are proportional (only one non-zero ratio group),
  // or multiple groups with clean ratios → use fr
  const nonZeroGroups = groups.filter((_, i) => ratios[i] > 0);

  if (nonZeroGroups.length === 0) {
    return sizes.map((s) => ({ value: Math.round(s), unit: "px" }));
  }

  // Check if ratios form clean fractions (all are multiples of 0.5)
  const allClean = ratios.every((r) => r === 0 || Math.abs(r - Math.round(r * 2) / 2) < 0.01);

  if (!allClean || nonZeroGroups.length < 2) {
    // Not enough evidence for fr — check if all non-zero are ~equal
    const nonZeroSizes = sizes.filter((s) => s > tolerance);
    if (nonZeroSizes.length > 1 && allSimilar(nonZeroSizes, tolerance)) {
      // All tracks are roughly equal → use 1fr for each
      return sizes.map((s) =>
        s <= tolerance ? { value: Math.round(s), unit: "px" } : { value: 1, unit: "fr" },
      );
    }
    return sizes.map((s) => ({ value: Math.round(s), unit: "px" }));
  }

  // Use fr units based on discovered ratios
  const result: SizeExpression[] = new Array(sizes.length);
  for (let g = 0; g < groups.length; g++) {
    const ratio = ratios[g];
    for (const idx of groups[g]) {
      if (ratio === 0) {
        result[idx] = { value: 0, unit: "px" };
      } else {
        // Normalize to smallest integer ratios
        const normalizedRatio = ratio * 2;
        result[idx] = {
          value: normalizedRatio === Math.round(normalizedRatio) ? normalizedRatio / 2 : ratio,
          unit: "fr",
        };
      }
    }
  }

  return result;
}

function allSimilar(values: number[], tolerance: number): boolean {
  if (values.length <= 1) return true;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return values.every((v) => Math.abs(v - avg) <= tolerance);
}

/**
 * Simplify a full GridConfig by applying track simplification
 * and removing trivial empty rows/columns from the edges.
 */
export function simplifyGridConfig(
  config: GridConfig,
  tolerance: number,
  discoverFractions: boolean,
): GridConfig {
  const rowSizes = config.rows.map((r) => r.value);
  const colSizes = config.columns.map((c) => c.value);

  const simplifiedRows = simplifyTrackSizes(rowSizes, tolerance, discoverFractions);
  const simplifiedCols = simplifyTrackSizes(colSizes, tolerance, discoverFractions);

  const result: GridConfig = {
    rows: simplifiedRows,
    columns: simplifiedCols,
    areas: config.areas,
  };

  if (config.children) {
    result.children = {};
    for (const [key, child] of Object.entries(config.children)) {
      result.children[key] = simplifyGridConfig(child, tolerance, discoverFractions);
    }
  }

  return result;
}
