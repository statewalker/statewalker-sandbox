import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BenchRow, Check, Fixtures } from "../../05-runtime-matrix/src/types.js";
import { makeFixtures } from "../../05-runtime-matrix/tests/make-fixtures.js";
import { ALGOS, extractFromHashWasm } from "../scripts/extract-wasm.js";
import { runWasmBench, runWasmConformance, WASM_BENCH_NAMES } from "../src/conformance.js";
import { compileModulesFromBytes } from "../src/load-from-bytes.js";
import * as embedded from "../src/wasm/binaries.js";
import { createWasmHasher, type WasmModules } from "../src/wasm-hasher.js";
import { WORKERD_NATIVE_BENCH_NAMES } from "../src/workerd-native.js";
import { EXPECTED_FAMILIES, EXPECTED_TOTAL, familyCounts } from "./expected.js";

const wasmDir = join(import.meta.dirname, "../src/wasm");
let fx: Fixtures;
let modules: WasmModules;
beforeAll(async () => {
  fx = makeFixtures();
  modules = await compileModulesFromBytes();
});

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

describe("R1 committed binaries are hash-wasm@4.13.0's, byte for byte", () => {
  it("re-extraction equals the committed .wasm files and their base64 copies", () => {
    const { version, binaries } = extractFromHashWasm();
    expect(version).toBe("4.13.0");
    const b64: Record<string, string> = {
      blake3: embedded.BLAKE3_WASM_B64,
      sha1: embedded.SHA1_WASM_B64,
      sha256: embedded.SHA256_WASM_B64,
    };
    for (const algo of ALGOS) {
      const committed = new Uint8Array(readFileSync(join(wasmDir, `${algo}.wasm`)));
      expect(Buffer.from(committed).equals(Buffer.from(binaries[algo] ?? []))).toBe(true);
      expect(b64[algo]).toBe(Buffer.from(committed).toString("base64"));
    }
  });
});

describe("R2–R5 every check passes in Node (modules compiled from bytes)", () => {
  it("node", async () => {
    assertAllPass(await runWasmConformance(fx, modules));
  });
  it("derive_key is rejected, not silently computed as something else", async () => {
    await expect(
      createWasmHasher(modules.blake3, "blake3", { context: new Uint8Array(4) }),
    ).rejects.toThrow(/derive_key/);
  });
  it("a key that is not 32 bytes is rejected", async () => {
    await expect(
      createWasmHasher(modules.blake3, "blake3", { key: new Uint8Array(31) }),
    ).rejects.toThrow(/32/);
  });
});

describe("R6 workerd: precompiled module imports work; compiling from bytes is refused", () => {
  let mf: Miniflare;
  beforeAll(async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("../src/workerd-entry.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      external: ["*.wasm"],
      logLevel: "silent",
    });
    const entry = out.outputFiles[0]?.text ?? "";
    expect(entry).not.toMatch(/["']node:/);
    mf = new Miniflare({
      modules: [
        { type: "ESModule", path: join(wasmDir, "../entry.mjs"), contents: entry },
        ...ALGOS.map((algo) => ({
          type: "CompiledWasm" as const,
          path: join(wasmDir, `${algo}.wasm`),
          contents: readFileSync(join(wasmDir, `${algo}.wasm`)),
        })),
      ],
      compatibilityDate: "2026-07-01",
    });
  }, 120_000);
  afterAll(async () => {
    await mf?.dispose();
  });

  it("every check passes with modules imported precompiled", async () => {
    const res = await mf.dispatchFetch("http://x/conformance", {
      method: "POST",
      body: JSON.stringify(fx),
    });
    assertAllPass((await res.json()) as Check[]);
  }, 120_000);
  it("workerd's native crypto.DigestStream (SHA-1, SHA-256) matches git and node:crypto", async () => {
    const res = await mf.dispatchFetch("http://x/digeststream", {
      method: "POST",
      body: JSON.stringify(fx),
    });
    const checks = (await res.json()) as Check[];
    expect(checks.length).toBe(fx.gitObjects.length + fx.sha256.length);
    const failed = checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
  });
  it("trap: compiling the same binary from bytes is refused by workerd", async () => {
    const text = await (await mf.dispatchFetch("http://x/compile-from-bytes")).text();
    expect(text).toMatch(/^refused: .*disallowed by embedder/);
  });
  it("R7 bench in workerd (timed from outside)", async () => {
    const wall = async (path: string) => {
      const t = performance.now();
      const body = await (await mf.dispatchFetch(`http://x${path}`)).text();
      return { ms: performance.now() - t, body };
    };
    await wall("/noop");
    const noop = Math.min((await wall("/noop")).ms, (await wall("/noop")).ms);
    const rows: BenchRow[] = [];
    for (const name of [...WASM_BENCH_NAMES, ...WORKERD_NATIVE_BENCH_NAMES]) {
      await wall(`/bench/${name}`);
      const { ms, body } = await wall(`/bench/${name}`);
      rows.push({ ...(JSON.parse(body) as BenchRow), ms: ms - noop });
    }
    console.log(`workerd bench\n${fmt(rows)}`);
    for (const r of rows) expect(r.ms).toBeGreaterThan(0);
  }, 300_000);
});

describe("R7 bench in Node", () => {
  it("node", async () => {
    const rows: BenchRow[] = [];
    for (const name of WASM_BENCH_NAMES) {
      await runWasmBench(name, modules);
      rows.push(await runWasmBench(name, modules));
    }
    console.log(`node bench\n${fmt(rows)}`);
    for (const r of rows) expect(r.ms).toBeGreaterThan(0);
  }, 300_000);
});
