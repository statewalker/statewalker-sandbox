/**
 * X1e checks and benches, portable: given compiled modules and X0a's fixtures, run every reference
 * comparison. Used in Node, a Chromium page and worker, and workerd.
 */
import { createSha1 } from "../../01-streaming-git-hash/src/git-object-hash.js";
import { createBlake3, createSha256, toHex } from "../../03-sha256-blake3/src/hashes.js";
import type { BenchRow, Check, Fixtures } from "../../05-runtime-matrix/src/types.js";
import { base64ToBytes, createWasmHasher, type WasmModules } from "./wasm-hasher.js";

export const WASM_BENCH_NAMES = [
  "blake3-wasm",
  "blake3-noble",
  "sha1-wasm",
  "sha1-noble",
  "sha256-wasm",
  "sha256-noble",
] as const;

export async function runWasmConformance(_fx: Fixtures, _modules: WasmModules): Promise<Check[]> {
  return [];
}

export async function runWasmBench(_name: string, _modules: WasmModules): Promise<BenchRow> {
  void createSha1;
  void createBlake3;
  void createSha256;
  void toHex;
  void base64ToBytes;
  void createWasmHasher;
  throw new Error("not implemented");
}
