// DERIVED-FROM-NOTE: 18-Prototype 8: Biscuit Enablement §3, §4.1, §4.2, §5
// DERIVED-FROM-NOTE: 24-Prototypes 2, 3 and 8 API Reference §4
//   ("Constraints discovered, which callers must respect")
//
// The archived suite (biscuit.test.ts, recovered verbatim) proves the
// SUBSTITUTION: Biscuit satisfies `Enablement` unchanged. It does not pin the
// three constraints the rung paid for on the way there. Those are here,
// because each one is a trap a later caller will otherwise fall into again.

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createBiscuitEnablement, loadBiscuit } from "../src/biscuit-enablement.js";
import { fact, factSetEnablement } from "../src/enablement.js";

/** The 20-fact background the note measured against (§5). */
const NOISE = Array.from({ length: 20 }, (_, i) => fact(`f${i}`, `v${i}`));
const FACTS = [...NOISE, fact("selection", "file"), fact("mesh", "connected")];
const TWO_CLAUSE = 'selection("file"), mesh("connected")';

describe("the WASM module loads without a Node flag", () => {
  // Note 06 §6 warned that "WASM support in Node needs an explicit flag, which
  // affects the test runner". Note 18 §3 retracts that: the package README is
  // stale and the module loads with only an ExperimentalWarning. This test
  // exists so the retraction stays checked rather than remembered.
  it("resolves with no --experimental-wasm-modules in execArgv", async () => {
    const flags = [...process.execArgv, ...(process.env["NODE_OPTIONS"] ?? "").split(/\s+/)];
    expect(flags.filter((f) => f.includes("wasm"))).toEqual([]);
    await expect(loadBiscuit()).resolves.toBeDefined();
  });
});

describe("reusing an Authorizer", () => {
  /**
   * §4.1 is the rung's most important discovery, and the reason `authorizer()`
   * is called per query rather than per evaluation. Reproducing it here
   * CORRECTED it, and the correction matters more than the original claim.
   *
   * The note says the Authorizer is single-use: a second `query()` fails with
   * `RunLimit::Timeout`. That reproduces exactly — in a cold process. It does
   * NOT reproduce once the engine is warm: after a few hundred queries the
   * same reuse succeeds essentially always (measured below; 1 failure in 300,
   * and 0 in 20 even with 5,000 facts in the world).
   *
   * So the rule is not structural, it is a TIMING LIMIT — biscuit's default
   * `max_time` is 1 ms and a cold WASM run overruns it. That is worse than a
   * hard rule, not better: reuse is code that passes its own tests on a warm
   * engine and fails on a user's first click. The mitigation the rung chose —
   * one authorizer per query — is unchanged and now better justified.
   */

  /**
   * Cold by construction: a fresh Node process, so this is the condition the
   * rung measured under. Reproduced 10/10 by hand before being written down.
   */
  it("fails in a cold process, and the thrown value is not an Error at all", () => {
    const script = `
      const bis = await import("@biscuit-auth/biscuit-wasm");
      const b = new bis.AuthorizerBuilder();
      b.addCode('selection("file");');
      b.addCode('mesh("connected");');
      const a = b.buildUnauthenticated();
      const out = { first: a.query(bis.Rule.fromString('_m(true) <- selection("file")')).length };
      try {
        out.second = { ok: a.query(bis.Rule.fromString('_m(true) <- mesh("connected")')).length };
      } catch (e) {
        out.second = { threw: true, isError: e instanceof Error, message: e?.message ?? null,
                       json: JSON.parse(JSON.stringify(e)) };
      }
      process.stdout.write("RESULT " + JSON.stringify(out));
    `;
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const result = JSON.parse(stdout.slice(stdout.indexOf("RESULT ") + 7)) as {
      first: number;
      second: { threw?: boolean; isError?: boolean; message?: string | null; json?: unknown };
    };

    expect(result.first).toBe(1);
    expect(result.second.threw).toBe(true);
    // The failure is nastier than the note records. It is not merely that the
    // message says "timeout" instead of "misuse": the thrown VALUE IS NOT AN
    // ERROR. It is a bare object. A caller writing the ordinary
    // `catch (e) { log(e.message) }` logs `undefined` and learns nothing.
    expect(result.second.isError).toBe(false);
    expect(result.second.message).toBeNull();
    expect(result.second.json).toEqual({ RunLimit: "Timeout" });
  });

  it("stops failing once the engine is warm — so 'single-use' is a timing artefact, not a rule", async () => {
    const bis = await loadBiscuit();
    const build = () => {
      const b = new bis.AuthorizerBuilder();
      b.addCode('selection("file");');
      b.addCode('mesh("connected");');
      return b.buildUnauthenticated();
    };
    const reuse = (): unknown | undefined => {
      const a = build();
      a.query(bis.Rule.fromString('_m(true) <- selection("file")'));
      try {
        a.query(bis.Rule.fromString('_m(true) <- mesh("connected")'));
        return undefined;
      } catch (err) {
        return err;
      }
    };

    for (let i = 0; i < 200; i++) reuse(); // warm the engine

    const TRIALS = 200;
    const failures: unknown[] = [];
    for (let i = 0; i < TRIALS; i++) {
      const err = reuse();
      if (err !== undefined) failures.push(err);
    }

    process.stdout.write(
      `\n  reusing a WARM authorizer: ${failures.length}/${TRIALS} second queries failed ` +
        `(cold, it is 10/10 — see the test above)\n`,
    );

    // Deliberately NOT asserting a rate: it is a wall-clock race, and any
    // threshold here would be a flaky test making a claim it cannot support.
    // What IS asserted is the part that never varies — a reused authorizer
    // never yields a catchable Error, so no caller can handle it cleanly.
    for (const f of failures) {
      expect(f).not.toBeInstanceOf(Error);
      expect(JSON.parse(JSON.stringify(f))).toEqual({ RunLimit: "Timeout" });
    }
  });

  it("is why a fresh authorizer per query keeps evaluate() usable", async () => {
    // The wrapper's mitigation, asserted from the outside: repeated
    // evaluation over one Enablement instance must not degrade. If
    // `authorizer()` were hoisted out of `ask()`, these calls would start
    // throwing the bare object above instead of returning booleans — which
    // is what a mutation of that line does.
    const e = await createBiscuitEnablement([fact("selection", "file")]);
    expect(e.evaluate('selection("file")')).toBe(true);
    expect(e.evaluate('selection("folder")')).toBe(false);
    expect(e.evaluate('selection("file")')).toBe(true);
    // A two-clause `when` is already two queries inside one evaluate().
    expect(e.evaluate('selection("file"), !mesh("connected")')).toBe(true);
  });
});

describe("a rule head must carry at least one term", () => {
  // §4.2. Minor, but it silently shapes every rule the shell generates, and
  // it is invisible at the `Enablement` interface — only rule authors meet it.
  it("rejects a zero-term head and accepts _m(true)", async () => {
    const bis = await loadBiscuit();
    expect(() => bis.Rule.fromString('_m() <- selection("file")')).toThrow();
    expect(() => bis.Rule.fromString('_m(true) <- selection("file")')).not.toThrow();
  });
});

describe("the cost of substitution", () => {
  /**
   * §5 measured 0.586 ms per evaluation and 17.6 ms for a 30-entry menu, and
   * concluded that caching is REQUIRED rather than optional because 17.6 ms
   * exceeds a 16.7 ms frame budget.
   *
   * This test does not assert that threshold. A threshold assertion here
   * would be a timing race on a loaded machine, and — worse — a green run
   * would be read as "the cost is fine", which is the opposite of the
   * finding. What it does instead is MEASURE and RECORD, so the number is
   * visible in the run output next to the number the note recorded, and so a
   * catastrophic regression (an authorizer built per fact, say) still fails.
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

    // Recorded, not asserted. The run output is the artefact.
    // NOTE: written to stdout directly. Under the app's happy-dom
    // environment `console.log` goes to the DOM's virtual console and never
    // reaches the terminal, so a measurement logged that way would be
    // invisible — which would defeat the whole point of this test.
    const report = [
      "",
      "  enablement cost — 20 facts, two-clause `when`, 200 iterations after warm-up",
      "  ┌───────────┬──────────────────┬───────────────┐",
      "  │           │  per evaluation  │ 30-entry menu │",
      "  ├───────────┼──────────────────┼───────────────┤",
      `  │ stub      │ ${stubMs.toFixed(3).padStart(11)} ms  │ ${(stubMs * MENU).toFixed(1).padStart(9)} ms  │`,
      `  │ biscuit   │ ${biscuitMs.toFixed(3).padStart(11)} ms  │ ${(biscuitMs * MENU).toFixed(1).padStart(9)} ms  │`,
      "  └───────────┴──────────────────┴───────────────┘",
      `  ratio ${(biscuitMs / stubMs).toFixed(1)}x · note 18 §5 recorded 0.586 ms / 17.6 ms / ~8x`,
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

    // The only assertions are ones that cannot race:
    expect(Number.isFinite(biscuitMs)).toBe(true);
    expect(biscuitMs).toBeGreaterThan(0);
    // A ~135x ceiling on the note's figure. Not a frame budget, not a
    // performance target — a tripwire for a change that makes evaluation
    // pathological (rebuilding an authorizer per FACT rather than per query
    // costs far more than this).
    expect(biscuitMs).toBeLessThan(80);
  });
});
