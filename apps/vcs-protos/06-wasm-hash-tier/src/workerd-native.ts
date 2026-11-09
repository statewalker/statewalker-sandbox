/** workerd-only native streaming hashes (crypto.DigestStream). STUB (red phase). */
import type { BenchRow, Check, Fixtures } from "../../05-runtime-matrix/src/types.js";

export const WORKERD_NATIVE_BENCH_NAMES = ["sha1-digeststream", "sha256-digeststream"] as const;

export async function runDigestStreamConformance(_fx: Fixtures): Promise<Check[]> {
  return [];
}
export async function runDigestStreamBench(_name: string): Promise<BenchRow> {
  throw new Error("not implemented");
}
