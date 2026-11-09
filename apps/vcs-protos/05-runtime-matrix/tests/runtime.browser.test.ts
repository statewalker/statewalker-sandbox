import { describe, expect, inject, it } from "vitest";
import { BENCH_NAMES, expectedCheckNames, runBench, runConformance } from "../src/conformance.js";
import type { BenchRow, Check } from "../src/types.js";
import { EXPECTED_FAMILIES, EXPECTED_TOTAL, familyCounts } from "./expected.js";
import { cloneFixtures, TAMPERS } from "./tamper.js";

const fx = inject("fixtures");

function assertAllPass(checks: Check[]) {
  expect(checks.length).toBe(EXPECTED_TOTAL);
  expect(familyCounts(checks)).toEqual(EXPECTED_FAMILIES);
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

describe("R3b negative controls in the page", () => {
  for (const t of TAMPERS) {
    it(t.family, async () => {
      const bad = cloneFixtures(fx);
      const expected = t.apply(bad);
      expect((await runConformance(bad)).filter((c) => !c.ok).map((c) => c.name)).toEqual(expected);
    });
  }
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
    // One worker for warm-up and timing, so its JIT is as warm as the page's (review of #51).
    const { rows } = await inWorker<{ rows: BenchRow[] }>({ benchAll: [...BENCH_NAMES] });
    console.log(`chromium worker bench\n${fmt(rows)}`);
    for (const r of rows) expect(r.ms).toBeGreaterThan(0);
  }, 300_000);
});
