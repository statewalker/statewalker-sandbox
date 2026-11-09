import { describe, expect, inject, it } from "vitest";
import { BENCH_NAMES, expectedCheckNames, runBench, runConformance } from "../src/conformance.js";
import type { BenchRow, Check } from "../src/types.js";

const fx = inject("fixtures");

function assertAllPass(checks: Check[]) {
  expect(checks.map((c) => c.name)).toEqual(expectedCheckNames(fx));
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
  const w = new Worker(new URL("./conformance.worker.ts", import.meta.url), { type: "module" });
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

describe("R3 every check passes in a Chromium page", () => {
  it("page", async () => {
    expect(typeof window).toBe("object");
    assertAllPass(await runConformance(fx));
  }, 120_000);
});

describe("R4 every check passes in a Chromium Dedicated Worker", () => {
  it("worker", async () => {
    const { checks } = await inWorker<{ checks: Check[] }>({ fixtures: fx });
    assertAllPass(checks);
  }, 120_000);
});

describe("R6 bench in the page and the worker", () => {
  it("page", async () => {
    const rows: BenchRow[] = [];
    for (const name of BENCH_NAMES) {
      await runBench(name);
      rows.push(await runBench(name));
    }
    console.log(`chromium page bench\n${fmt(rows)}`);
    for (const r of rows) expect(r.ms).toBeGreaterThan(0);
  }, 300_000);
  it("worker", async () => {
    const rows: BenchRow[] = [];
    for (const name of BENCH_NAMES) {
      await inWorker({ bench: name });
      rows.push((await inWorker<{ row: BenchRow }>({ bench: name })).row);
    }
    console.log(`chromium worker bench\n${fmt(rows)}`);
    for (const r of rows) expect(r.ms).toBeGreaterThan(0);
  }, 300_000);
});
