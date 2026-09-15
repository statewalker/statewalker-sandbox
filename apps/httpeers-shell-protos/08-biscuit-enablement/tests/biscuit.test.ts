// RECOVERED-FROM-ARCHIVE: notes/drive/2026-09-02.Httpeers-Shell/
//   17-prototype-08-biscuit-enablement.tar.gz -> proto8-biscuit/test/biscuit.test.ts
// Verbatim apart from this header. Nothing in the body was rewritten.
// Since 2026-09-15 it runs against the ADAPTED adapter (webrun-biscuit, not
// biscuit-wasm), still with no assertion changed: the substitution claim, re-asked.
import { describe, expect, it, vi } from "vitest";
import { fact, factSetEnablement, type Enablement } from "../src/enablement.js";
import { createBiscuitEnablement, loadBiscuit } from "../src/biscuit-enablement.js";

/**
 * PROTOTYPE 8 — does Biscuit satisfy `Enablement` unchanged?
 *
 * This is a SUBSTITUTION test, not a design question. The interface was
 * built in prototype 1 specifically as the swap point. If substitution
 * requires the interface to change, the abstraction was wrong — and that
 * is itself the finding.
 *
 * The core suite therefore runs the SAME assertions against both
 * implementations. Anything the stub does that Biscuit cannot, or vice
 * versa, shows up as a divergence.
 */

const IMPLEMENTATIONS: [string, (initial?: readonly ReturnType<typeof fact>[]) => Promise<Enablement> | Enablement][] = [
  ["stub", (initial) => factSetEnablement(initial ?? [])],
  ["biscuit", (initial) => createBiscuitEnablement(initial ?? [])],
];

describe.each(IMPLEMENTATIONS)("Enablement contract: %s", (_name, make) => {
  it("treats an absent or empty when clause as always enabled", async () => {
    const e = await make();
    expect(e.evaluate(undefined)).toBe(true);
    expect(e.evaluate("")).toBe(true);
    expect(e.evaluate("   ")).toBe(true);
  });

  it("matches a single fact", async () => {
    const e = await make([fact("selection", "file")]);
    expect(e.evaluate('selection("file")')).toBe(true);
    expect(e.evaluate('selection("folder")')).toBe(false);
  });

  it("treats comma as conjunction", async () => {
    const e = await make([fact("mesh", "connected"), fact("focus", "explorer")]);
    expect(e.evaluate('mesh("connected"), focus("explorer")')).toBe(true);
    expect(e.evaluate('mesh("connected"), focus("editor")')).toBe(false);
  });

  it("supports negation", async () => {
    const e = await make([fact("mesh", "connected")]);
    expect(e.evaluate('!mesh("disconnected")')).toBe(true);
    expect(e.evaluate('!mesh("connected")')).toBe(false);
  });

  it("re-evaluates after facts change", async () => {
    const e = await make();
    const when = 'selection("file")';
    expect(e.evaluate(when)).toBe(false);
    e.assert(fact("selection", "file"));
    expect(e.evaluate(when)).toBe(true);
    e.retract(fact("selection", "file"));
    expect(e.evaluate(when)).toBe(false);
  });

  it("notifies observers only on real change", async () => {
    const e = await make();
    const cb = vi.fn();
    e.onChange(cb);

    e.assert(fact("selection", "file"));
    expect(cb).toHaveBeenCalledTimes(1);
    e.assert(fact("selection", "file"));
    expect(cb).toHaveBeenCalledTimes(1);
    e.retract(fact("selection", "file"));
    expect(cb).toHaveBeenCalledTimes(2);
    e.retract(fact("selection", "file"));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("handles multi-term facts", async () => {
    const e = await make([fact("right", "peer1", "read")]);
    expect(e.evaluate('right("peer1", "read")')).toBe(true);
    expect(e.evaluate('right("peer1", "write")')).toBe(false);
  });

  it("replaces the whole fact set", async () => {
    const e = await make([fact("a", "1")]);
    e.setFacts([fact("b", "2")]);
    expect(e.evaluate('a("1")')).toBe(false);
    expect(e.evaluate('b("2")')).toBe(true);
  });

  it("rejects malformed clauses loudly rather than silently disabling", async () => {
    const e = await make();
    expect(() => e.evaluate("selection")).toThrow();
  });
});

describe("what Biscuit adds beyond the stub", () => {
  it("evaluates a rule with variables -- the stub cannot", async () => {
    const e = await createBiscuitEnablement([
      fact("right", "peer1", "read"),
      fact("current_peer", "peer1"),
    ]);
    // A real Datalog join: enabled if the CURRENT peer holds the right.
    expect(e.query('allowed($op) <- current_peer($p), right($p, $op)')).toEqual(["read"]);
  });

  it("supports disjunction through multiple rules", async () => {
    const e = await createBiscuitEnablement([fact("selection", "folder")]);
    // A rule head must carry at least one term: `ok()` is a parse error.
    expect(
      e.queryAny([
        '_m(true) <- selection("file")',
        '_m(true) <- selection("folder")',
      ]),
    ).toBe(true);
    expect(
      e.queryAny([
        '_m(true) <- selection("file")',
        '_m(true) <- selection("image")',
      ]),
    ).toBe(false);
  });

  it("uses parameter injection so untrusted input cannot inject Datalog", async () => {
    // Menu contributions come from FOREIGN PEER APPS, so a `when` string is
    // attacker-controlled. A value containing Datalog syntax must be treated
    // as a value, never as code.
    const hostile = 'file") or true or selection("';
    const e = await createBiscuitEnablement([fact("selection", "file")]);
    expect(e.matchesTerm("selection", hostile)).toBe(false);
    expect(e.matchesTerm("selection", "file")).toBe(true);
  });
});

describe("loading", () => {
  it("is async, and the interface is only available after load", async () => {
    const mod = await loadBiscuit();
    expect(mod).toBeDefined();
  });

  it("loads once across repeated calls", async () => {
    const a = await loadBiscuit();
    const b = await loadBiscuit();
    expect(a).toBe(b);
  });
});
