// DERIVED-FROM-NOTE: 18-Prototype 8: Biscuit Enablement §3, §4.1, §4.2, §5
// DERIVED-FROM-NOTE: 24-Prototypes 2, 3 and 8 API Reference §4
//   ("Constraints discovered, which callers must respect")
//
// The archived suite (biscuit.test.ts, recovered verbatim) proves the
// SUBSTITUTION: Biscuit satisfies `Enablement` unchanged. It does not pin the
// three constraints the rung paid for on the way there. Those are here,
// because each one is a trap a later caller will otherwise fall into again.
//
// REVISED 2026-09-15, when the adapter moved from `@biscuit-auth/biscuit-wasm`
// to `@statewalker/webrun-biscuit`. Each constraint is re-asked of the new
// engine rather than deleted: two of the three belonged to the WASM build and
// are now asserted GONE, which is itself a finding a later caller needs. The
// wasm-era tests are at statewalker-sandbox `cd5bb00`, this same path.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBiscuitEnablement, loadBiscuit } from "../src/biscuit-enablement.js";
import { fact, factSetEnablement } from "../src/enablement.js";

/** The 20-fact background the note measured against (§5). */
const NOISE = Array.from({ length: 20 }, (_, i) => fact(`f${i}`, `v${i}`));
const FACTS = [...NOISE, fact("selection", "file"), fact("mesh", "connected")];
const TWO_CLAUSE = 'selection("file"), mesh("connected")';

describe("the engine is not WebAssembly at all", () => {
  // Note 06 §6 warned that WASM in Node needs a flag; note 18 §3 retracted it
  // (the wasm build loaded with only an ExperimentalWarning). The question is
  // now moot, and this pins WHY: nothing in the import graph is WebAssembly.
  it("loads with no wasm in execArgv and no wasm dependency", async () => {
    const flags = [...process.execArgv, ...(process.env["NODE_OPTIONS"] ?? "").split(/\s+/)];
    expect(flags.filter((f) => f.includes("wasm"))).toEqual([]);
    await expect(loadBiscuit()).resolves.toBeDefined();
    // cwd, not import.meta.url: under the app's happy-dom environment the latter
    // is not a file: URL. The cold-process test below relies on cwd the same way.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).filter((d) => d.includes("wasm"))).toEqual([]);
  });
});

describe("reusing an evaluation", () => {
  /**
   * §4.1 was the rung's most important discovery: the wasm Authorizer was
   * single-use — a second `query()` failed with `RunLimit::Timeout` — and that
   * is why the recovered adapter built an authorizer per query. The wasm-era
   * version of this file then CORRECTED the note: it was a cold-engine timing
   * artefact (10/10 cold, 1/200 warm), and the thrown value was a bare object,
   * not an `Error`.
   *
   * The TypeScript engine has neither defect. These tests assert the constraint
   * is GONE — in the same cold process the wasm failed in, not only warm — which
   * is what licenses the adapted adapter to reuse one evaluation per fact set.
   */
  it("answers a second query in a cold process, where the wasm build failed 10/10", () => {
    const script = `
      const bis = await import("@statewalker/webrun-biscuit");
      const ev = bis.evaluate(null, 'selection("file");\\nmesh("connected");');
      const out = {
        first: ev.query('_m(true) <- selection("file")').length,
        second: ev.query('_m(true) <- mesh("connected")').length,
        third: ev.query('_m(true) <- selection("folder")').length,
      };
      process.stdout.write("RESULT " + JSON.stringify(out));
    `;
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(JSON.parse(stdout.slice(stdout.indexOf("RESULT ") + 7))).toEqual({
      first: 1,
      second: 1,
      third: 0,
    });
  });

  it("reports a bad query as an Error — the wasm threw a bare object", async () => {
    const bis = await loadBiscuit();
    const ev = bis.evaluate(null, 'selection("file");');
    let thrown: unknown;
    try {
      ev.query("_m(true) <- ");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toBe("");
  });

  it("keeps evaluate() correct across fact changes while the evaluation is cached", async () => {
    // The adapted adapter caches one evaluation per fact set. If the cache were
    // not dropped on change, the second and fourth answers below would be stale
    // — which is what a mutation of `fire()` produces.
    const e = await createBiscuitEnablement([fact("selection", "file")]);
    expect(e.evaluate('selection("file")')).toBe(true);
    expect(e.evaluate('selection("folder")')).toBe(false);
    e.assert(fact("selection", "folder"));
    expect(e.evaluate('selection("folder")')).toBe(true);
    e.retract(fact("selection", "file"));
    expect(e.evaluate('selection("file")')).toBe(false);
    // A two-clause `when` is two queries against the same evaluation.
    expect(e.evaluate('selection("folder"), !mesh("connected")')).toBe(true);
  });
});

describe("a rule head must carry at least one term", () => {
  // §4.2 — the one constraint that is a property of the LANGUAGE, not of the
  // build, and it survives the engine change. (webrun-biscuit 0.2.0 accepted
  // `f()` and rejected `_m` outright; 0.2.1 matches the reference on both.)
  it("rejects a zero-term head and accepts _m(true)", async () => {
    const bis = await loadBiscuit();
    const ev = bis.evaluate(null, 'selection("file");');
    expect(() => ev.query('_m() <- selection("file")')).toThrow();
    expect(ev.query('_m(true) <- selection("file")')).toHaveLength(1);
  });
});

describe("the cost of substitution", () => {
  /**
   * §5 measured 0.586 ms per evaluation and 17.6 ms for a 30-entry menu, and
   * concluded that caching is REQUIRED rather than optional because 17.6 ms
   * exceeds a 16.7 ms frame budget. On the wasm build this file measured
   * ~0.28 ms and 8.3 ms, a ratio of ~44x against the stub.
   *
   * This test does not assert a threshold: a threshold is a timing race on a
   * loaded machine, and a green run would be read as "the cost is fine". It
   * MEASURES and RECORDS, and keeps a tripwire for a catastrophic regression.
   */
  it("records the per-evaluation and 30-entry menu cost of both implementations", async ({
    annotate,
  }) => {
    const stub = factSetEnablement(FACTS);
    const biscuit = await createBiscuitEnablement(FACTS);

    const time = (run: () => void, iterations: number): number => {
      for (let i = 0; i < 50; i++) run(); // warm-up, as the note did
      const t0 = performance.now();
      for (let i = 0; i < iterations; i++) run();
      return (performance.now() - t0) / iterations;
    };

    const stubMs = time(() => void stub.evaluate(TWO_CLAUSE), 200);
    const biscuitMs = time(() => void biscuit.evaluate(TWO_CLAUSE), 200);
    const MENU = 30;
    const FRAME_BUDGET_MS = 16.7;

    // Recorded, not asserted. Written to stdout directly: under happy-dom
    // `console.log` goes to the DOM's virtual console and never reaches the
    // terminal, which would make the measurement invisible.
    const report = [
      "",
      "  enablement cost — 20 facts, two-clause `when`, 200 iterations after warm-up",
      "  ┌───────────┬──────────────────┬───────────────┐",
      "  │           │  per evaluation  │ 30-entry menu │",
      "  ├───────────┼──────────────────┼───────────────┤",
      `  │ stub      │ ${stubMs.toFixed(3).padStart(11)} ms  │ ${(stubMs * MENU).toFixed(1).padStart(9)} ms  │`,
      `  │ biscuit   │ ${biscuitMs.toFixed(3).padStart(11)} ms  │ ${(biscuitMs * MENU).toFixed(1).padStart(9)} ms  │`,
      "  └───────────┴──────────────────┴───────────────┘",
      `  ratio ${(biscuitMs / stubMs).toFixed(1)}x · note 18 §5 recorded 0.586 ms / 17.6 ms / ~8x;` +
        " the wasm build measured ~0.28 ms / 8.3 ms / ~44x",
      `  frame budget ${FRAME_BUDGET_MS} ms — a 30-entry menu ${
        biscuitMs * MENU > FRAME_BUDGET_MS ? "EXCEEDS" : "fits within"
      } it on this machine`,
      "",
    ].join("\n");
    process.stdout.write(`${report}\n`);
    await annotate(
      `stub ${stubMs.toFixed(3)} ms/eval, ${(stubMs * MENU).toFixed(1)} ms per ${MENU}-entry menu; ` +
        `biscuit ${biscuitMs.toFixed(3)} ms/eval, ${(biscuitMs * MENU).toFixed(1)} ms per ${MENU}-entry menu ` +
        `(${(biscuitMs / stubMs).toFixed(1)}x); frame budget ${FRAME_BUDGET_MS} ms`,
    );

    expect(Number.isFinite(biscuitMs)).toBe(true);
    expect(biscuitMs).toBeGreaterThan(0);
    // A tripwire, not a target: rebuilding the world per FACT would blow far past it.
    expect(biscuitMs).toBeLessThan(80);
  });
});
