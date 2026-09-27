// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §4 (the grammar, what
// throws, onChange fires only on real change)
// DERIVED-FROM-NOTE: 06-Enablement: When Clauses and the Biscuit Datalog
// Question.md §5 ("There is a passing test asserting that `||` throws")

import { describe, expect, it, vi } from "vitest";
import { fact, factSetEnablement } from "../src/enablement.js";

describe("the supported grammar", () => {
  it("an absent or empty when clause is always enabled", () => {
    const e = factSetEnablement();
    expect(e.evaluate(undefined)).toBe(true);
    expect(e.evaluate("")).toBe(true);
    expect(e.evaluate("   ")).toBe(true);
  });

  it("matches a single ground fact", () => {
    const e = factSetEnablement([fact("selection", "file")]);
    expect(e.evaluate('selection("file")')).toBe(true);
    expect(e.evaluate('selection("folder")')).toBe(false);
    expect(e.evaluate('focus("explorer")')).toBe(false);
  });

  it("treats the comma as AND", () => {
    const e = factSetEnablement([fact("mesh", "connected"), fact("focus", "explorer")]);
    expect(e.evaluate('mesh("connected"), focus("explorer")')).toBe(true);
    e.retract(fact("focus", "explorer"));
    expect(e.evaluate('mesh("connected"), focus("explorer")')).toBe(false);
  });

  it("treats `!` as negation", () => {
    const e = factSetEnablement();
    expect(e.evaluate('!selection("file")')).toBe(true);
    e.assert(fact("selection", "file"));
    expect(e.evaluate('!selection("file")')).toBe(false);
  });

  it("handles multi-term facts — the shape mirrors Datalog", () => {
    const e = factSetEnablement([fact("right", "peer1", "read")]);
    expect(e.evaluate('right("peer1", "read")')).toBe(true);
    expect(e.evaluate('right("peer1", "write")')).toBe(false);
    // The comma inside the argument list is not a conjunction separator.
    expect(e.evaluate('right("peer1", "read"), right("peer1", "read")')).toBe(true);
  });

  it("accepts number and boolean terms", () => {
    const e = factSetEnablement([fact("tabs", 3), fact("dirty", true)]);
    expect(e.evaluate("tabs(3)")).toBe(true);
    expect(e.evaluate("tabs(4)")).toBe(false);
    expect(e.evaluate("dirty(true)")).toBe(true);
    expect(e.evaluate("dirty(false)")).toBe(false);
  });

  it('does not confuse the number 3 with the string "3"', () => {
    const e = factSetEnablement([fact("tabs", 3)]);
    expect(e.evaluate("tabs(3)")).toBe(true);
    expect(e.evaluate('tabs("3")')).toBe(false);
  });
});

describe("what the stub refuses — needing it is the signal to bring in the real engine", () => {
  it("disjunction throws", () => {
    const e = factSetEnablement();
    expect(() => e.evaluate('selection("file") || selection("folder")')).toThrow(
      /Malformed when clause/,
    );
  });

  it("conjunction written as `&&` throws — the comma is the only AND", () => {
    const e = factSetEnablement();
    expect(() => e.evaluate('mesh("connected") && focus("explorer")')).toThrow(
      /Malformed when clause/,
    );
  });

  it("comparison operators throw", () => {
    const e = factSetEnablement();
    expect(() => e.evaluate("resourceScheme == 'peer'")).toThrow(/Malformed when clause/);
    expect(() => e.evaluate("tabs > 3")).toThrow(/Malformed when clause/);
  });

  it("variables throw", () => {
    const e = factSetEnablement();
    expect(() => e.evaluate('right($peer, "read")')).toThrow(/Malformed when clause/);
  });

  it("a VS Code-style bare context key throws", () => {
    const e = factSetEnablement();
    expect(() => e.evaluate("explorerFocus")).toThrow(/Malformed when clause/);
  });

  it("a malformed clause throws rather than quietly evaluating false", () => {
    const e = factSetEnablement();
    expect(() => e.evaluate("selection(")).toThrow(/Malformed when clause/);
    expect(() => e.evaluate('selection("file"),')).toThrow(/Malformed when clause/);
  });
});

describe("fact-set mutation and onChange", () => {
  it("re-asserting an existing fact is a no-op and does not fire onChange", () => {
    const e = factSetEnablement();
    const cb = vi.fn();
    e.onChange(cb);
    e.assert(fact("selection", "file"));
    expect(cb).toHaveBeenCalledTimes(1);
    e.assert(fact("selection", "file"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("retracting an absent fact does not fire onChange", () => {
    const e = factSetEnablement();
    const cb = vi.fn();
    e.onChange(cb);
    e.retract(fact("selection", "file"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("setFacts replaces the set, and fires only on a real change", () => {
    const e = factSetEnablement([fact("mesh", "connected")]);
    const cb = vi.fn();
    e.onChange(cb);
    e.setFacts([fact("mesh", "connected")]);
    expect(cb).not.toHaveBeenCalled();
    e.setFacts([fact("focus", "explorer")]);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(e.evaluate('mesh("connected")')).toBe(false);
    expect(e.evaluate('focus("explorer")')).toBe(true);
  });

  it("onChange returns a working disposer", () => {
    const e = factSetEnablement();
    const cb = vi.fn();
    e.onChange(cb)();
    e.assert(fact("selection", "file"));
    expect(cb).not.toHaveBeenCalled();
  });
});
