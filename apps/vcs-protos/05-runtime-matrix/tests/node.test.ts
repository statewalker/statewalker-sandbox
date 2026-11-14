import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BENCH_NAMES, expectedCheckNames, runBench, runConformance } from "../src/conformance.js";
import type { BenchRow, Check, Fixtures } from "../src/types.js";
import { EXPECTED_FAMILIES, EXPECTED_TOTAL, familyCounts } from "./expected.js";
import { makeFixtures } from "./make-fixtures.js";
import { cloneFixtures, TAMPERS } from "./tamper.js";

let fx: Fixtures;
beforeAll(() => {
  fx = makeFixtures();
});

function assertAllPass(checks: Check[]) {
  expect(checks.length).toBe(EXPECTED_TOTAL);
  expect(familyCounts(checks)).toEqual(EXPECTED_FAMILIES);
  expect(checks.map((c) => c.name)).toEqual(expectedCheckNames(fx));
  const failed = checks.filter((c) => !c.ok);
  expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
}

describe("R1 fixtures come from real oracles and are plain JSON", () => {
  it("round-trips through JSON unchanged and matches the literal check snapshot", () => {
    expect(JSON.parse(JSON.stringify(fx))).toEqual(fx);
    expect(fx.blake3.cases.length).toBe(35);
    expect(fx.packs.map((p) => p.kind)).toEqual(["ofs", "ref"]);
    expect(fx.zlib.lengths.length).toBe(fx.zlib.inputSha256.length);
    expect(expectedCheckNames(fx).length).toBe(EXPECTED_TOTAL);
  });
  it("is deterministic: the same seed gives byte-identical fixtures (every runner sees the same input)", () => {
    expect(JSON.stringify(makeFixtures())).toBe(JSON.stringify(fx));
  });
  it("stays small enough to post on every run (< 2 MB of JSON)", () => {
    expect(JSON.stringify(fx).length).toBeLessThan(2_000_000);
  });
});

describe("R2 every check passes in Node", () => {
  it("node", async () => {
    assertAllPass(await runConformance(fx));
  });
});

describe("R2b negative controls: one tamper per fixture family fails exactly its checks", () => {
  for (const t of TAMPERS) {
    it(t.family, async () => {
      const bad = cloneFixtures(fx);
      const expected = t.apply(bad);
      const failed = (await runConformance(bad)).filter((c) => !c.ok).map((c) => c.name);
      expect(failed).toEqual(expected);
    });
  }
});

describe("R5 workerd", () => {
  let mf: Miniflare;
  let bundle = "";
  beforeAll(async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("../src/workerd-entry.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
    });
    bundle = out.outputFiles[0]?.text ?? "";
    mf = new Miniflare({ modules: true, script: bundle, compatibilityDate: "2026-07-01" });
  }, 120_000);
  afterAll(async () => {
    await mf?.dispose();
  });

  it("bundles for a non-Node platform with nothing external and no node: specifier", () => {
    expect(bundle.length).toBeGreaterThan(10_000);
    expect(bundle).not.toMatch(/["']node:/);
  });
  it("every check passes in workerd", async () => {
    const res = await mf.dispatchFetch("http://x/conformance", {
      method: "POST",
      body: JSON.stringify(fx),
    });
    assertAllPass((await res.json()) as Check[]);
  }, 120_000);

  it("R6 bench in workerd (timed from outside; also valid where production timers are frozen)", async () => {
    const wall = async (path: string) => {
      const t = performance.now();
      const r = await mf.dispatchFetch(`http://x${path}`);
      const body = await r.text();
      return { ms: performance.now() - t, body };
    };
    await wall("/noop");
    const noop = Math.min((await wall("/noop")).ms, (await wall("/noop")).ms);
    const rows: BenchRow[] = [];
    for (const name of BENCH_NAMES) {
      await wall(`/bench/${name}`); // warm-up
      const { ms, body } = await wall(`/bench/${name}`);
      const inside = JSON.parse(body) as BenchRow;
      // Production Cloudflare freezes timers during execution (documented, not testable here), so
      // the outside measurement is the portable one. Both are logged: under Miniflare, workerd's
      // own performance.now() is expected to advance and roughly agree.
      console.log(
        `workerd ${name}: inside ${inside.ms.toFixed(0)} ms, outside ${(ms - noop).toFixed(0)} ms`,
      );
      rows.push({ ...inside, ms: ms - noop });
    }
    console.log(`workerd bench\n${formatRows(rows)}`);
    for (const r of rows) expect(r.ms).toBeGreaterThan(0);
  }, 300_000);
});

describe("R6 bench in Node", () => {
  it("node", async () => {
    const rows: BenchRow[] = [];
    for (const name of BENCH_NAMES) {
      await runBench(name);
      rows.push(await runBench(name));
    }
    console.log(`node bench\n${formatRows(rows)}`);
    for (const r of rows) expect(r.ms).toBeGreaterThan(0);
  }, 300_000);
});

export function formatRows(rows: BenchRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.name}: ${(r.amount / (r.ms / 1000)).toFixed(0)} ${r.unit}/s (${r.ms.toFixed(0)} ms)`,
    )
    .join("\n");
}
