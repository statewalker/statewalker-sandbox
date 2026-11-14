/** Literal snapshot of the X1e checks every runner must report (independent of conformance.ts). */
import type { Check } from "../../05-runtime-matrix/src/types.js";

export const EXPECTED_FAMILIES: Record<string, number> = {
  "blake3-wasm:hash": 35,
  "blake3-wasm:keyed_hash": 35,
  "blake3-wasm:derive_key-rejected": 1,
  "sha1-wasm:git": 5,
  "sha256-wasm": 3,
  chunking: 3,
  concurrent: 1,
  finalized: 1,
};
export const EXPECTED_TOTAL = 84;

export function familyCounts(checks: Check[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of checks) {
    const parts = c.name.split(":");
    const family =
      parts[0] === "blake3-wasm" || parts[0] === "sha1-wasm"
        ? `${parts[0]}:${parts[1]}`
        : (parts[0] ?? "");
    counts[family] = (counts[family] ?? 0) + 1;
  }
  return counts;
}
