/**
 * Literal snapshot of the checks every runner must report, independent of the conformance code:
 * if a fixture family or a chunk-size list silently shrank, both the run and
 * expectedCheckNames() would shrink together — these counts would not.
 */
import type { Check } from "../src/types.js";

export const EXPECTED_FAMILIES: Record<string, number> = {
  git: 10, // 5 objects × 2 SHA-1 implementations
  "blake3:hash": 35,
  "blake3:keyed_hash": 35,
  "blake3:derive_key": 35,
  sha256: 3,
  lfs: 3,
  "inflate:push": 3,
  "inflate:pooled": 3,
  "pack:ofs": 2,
  "pack:ref": 2,
};
export const EXPECTED_TOTAL = 131;

export function familyCounts(checks: Check[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of checks) {
    const parts = c.name.split(":");
    const family =
      parts[0] === "blake3" || parts[0] === "inflate" || parts[0] === "pack"
        ? `${parts[0]}:${parts[1]}`
        : (parts[0] ?? "");
    counts[family] = (counts[family] ?? 0) + 1;
  }
  return counts;
}
