import { describe, expect, inject, it } from "vitest";
import type { BenchRow, Check } from "../../05-runtime-matrix/src/types.js";
import { runWasmBench, runWasmConformance, WASM_BENCH_NAMES } from "../src/conformance.js";
import { compileModulesFromBytes } from "../src/load-from-bytes.js";
import { EXPECTED_FAMILIES, EXPECTED_TOTAL, familyCounts } from "./expected.js";

const fx = inject("fixtures");

function assertAllPass(checks: Check[]) {
  expect(checks.length).toBe(EXPECTED_TOTAL);
  expect(familyCounts(checks)).toEqual(EXPECTED_FAMILIES);
  const failed = checks.filter((c) => !c.ok);
  expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
}
const fmt = (rows: BenchRow[]) =>
  rows
    .map(
      (r) =>
        `${r.name}: ${(r.amount / (r.ms / 1000)).toFixed(0)} ${r.unit}/s (${r.ms.toFixed(0)} ms)`,
    )
    .join("\n");

function inWorker<T>(msg: unknown): Promise<T> {
  const w = new Worker(new URL("./wasm.worker.ts", import.meta.url), { type: "module" });
  return new Promise<T>((resolve, reject) => {
    w.onmessage = (e) => {
      w.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data as T);
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message));
    };
    w.postMessage(msg);
  });
}

describe("R6 every check passes in a Chromium page and Dedicated Worker", () => {
  it("page", async () => {
    assertAllPass(await runWasmConformance(fx, await compileModulesFromBytes()));
  });
  it("worker", async () => {
    assertAllPass((await inWorker<{ checks: Check[] }>({ fixtures: fx })).checks);
  });
});

describe("R7 bench in the page and the worker", () => {
  it("page", async () => {
    const modules = await compileModulesFromBytes();
    const rows: BenchRow[] = [];
    for (const name of WASM_BENCH_NAMES) {
      await runWasmBench(name, modules);
      rows.push(await runWasmBench(name, modules));
    }
    console.log(`chromium page bench\n${fmt(rows)}`);
    for (const r of rows) expect(r.ms).toBeGreaterThan(0);
  }, 300_000);
  it("worker", async () => {
    const { rows } = await inWorker<{ rows: BenchRow[] }>({ benchAll: [...WASM_BENCH_NAMES] });
    console.log(`chromium worker bench\n${fmt(rows)}`);
    for (const r of rows) expect(r.ms).toBeGreaterThan(0);
  }, 300_000);
});
