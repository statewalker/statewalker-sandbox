/** X0a — one portable conformance run over the X1 modules. STUB (red phase). */
import type { BenchRow, Check, Fixtures } from "./types.js";

export function expectedCheckNames(_fx: Fixtures): string[] {
  throw new Error("not implemented");
}

export async function runConformance(_fx: Fixtures): Promise<Check[]> {
  return [];
}

export async function runBench(_name: string): Promise<BenchRow> {
  throw new Error("not implemented");
}

export const BENCH_NAMES = [
  "sha1-noble",
  "sha256-noble",
  "blake3-noble",
  "inflate-pooled",
] as const;
