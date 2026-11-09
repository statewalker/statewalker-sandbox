import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BENCH_NAMES, expectedCheckNames, runBench, runConformance } from "../src/conformance.js";
import type { BenchRow, Check, Fixtures } from "../src/types.js";
import { makeFixtures } from "./make-fixtures.js";

let fx: Fixtures;
beforeAll(() => {
  fx = makeFixtures();
});

function assertAllPass(checks: Check[]) {
  expect(checks.map((c) => c.name)).toEqual(expectedCheckNames(fx));
  const failed = checks.filter((c) => !c.ok);
  expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
}

describe("R1 fixtures come from real oracles and are plain JSON", () => {
  it("round-trips through JSON unchanged and covers every check family", () => {
    expect(JSON.parse(JSON.stringify(fx))).toEqual(fx);
    expect(fx.gitObjects.length).toBeGreaterThanOrEqual(5);
    expect(fx.blake3.cases.length).toBe(35);
    expect(fx.packs.map((p) => p.kind)).toEqual(["ofs", "ref"]);
    expect(fx.zlib.lengths.length).toBe(fx.zlib.inputs.length);
    expect(expectedCheckNames(fx).length).toBeGreaterThan(100);
  });
});

describe("R2 every check passes in Node", () => {
  it("node", async () => {
    assertAllPass(await runConformance(fx));
  });
});

describe("R2b the conformance run discriminates (negative control)", () => {
  it("tampered fixtures fail exactly the tampered checks", async () => {
    const bad: Fixtures = JSON.parse(JSON.stringify(fx));
    const obj = bad.gitObjects[1];
    if (obj) obj.id = obj.id.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const vec = bad.blake3.cases[5];
    if (vec) vec.keyed_hash = vec.keyed_hash.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const sha = bad.sha256[1];
    if (sha) sha.hex = "0".repeat(64);
    bad.zlib.lengths[3] = (bad.zlib.lengths[3] ?? 0) + 1;
    const pack = bad.packs[0];
    if (pack) pack.offsets[2] = (pack.offsets[2] ?? 0) + 1;
    const failed = (await runConformance(bad)).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual([
      `git:${obj?.name}:vcs`,
      `git:${obj?.name}:noble`,
      `blake3:keyed_hash:${vec?.input_len}`,
      `sha256:${sha?.name}`,
      "inflate:push:chunk1",
      "inflate:push:chunk7",
      "inflate:push:chunk4096",
      "inflate:pooled:chunk1",
      "inflate:pooled:chunk7",
      "inflate:pooled:chunk4096",
      "pack:ofs:chunk1",
      "pack:ofs:chunk65536",
    ]);
  });
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
      // Under Miniflare, workerd's performance.now() advances during compute and agrees with the
      // outside wall clock (probe: 288 vs 297 ms). Production Cloudflare freezes timers during
      // execution (documented, not testable here), so the outside measurement is the portable one.
      expect(inside.ms).toBeGreaterThan(0);
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
