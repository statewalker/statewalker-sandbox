import { describe, expect, it } from "vitest";
import { BaseClass } from "@statewalker/shared-baseclass";
import { expectEdgeCounter, expectNoSelfWake, expectReplacedNotMutated, probe } from "@fm/app";

/**
 * C1 — the kit is red-tested before it is trusted: each helper must FAIL a
 * deliberately broken fixture and PASS a correct one. A test helper that
 * cannot fail is worse than none, because it reports safety it never checked.
 */

class ListModel extends BaseClass {
  items: string[] = [];
  pushInPlace(v: string) { this.items.push(v); this.notify(); }
  replace(v: string) { this.items = [...this.items, v]; this.notify(); }
}

describe("expectReplacedNotMutated", () => {
  it("fails a model that mutates its array in place", async () => {
    const model = new ListModel();
    await expect(
      expectReplacedNotMutated(model, () => model.items, () => model.pushInPlace("a")),
    ).rejects.toThrow(/mutated in place/);
  });

  it("passes a model that replaces the value", async () => {
    const model = new ListModel();
    await expect(
      expectReplacedNotMutated(model, () => model.items, () => model.replace("a")),
    ).resolves.toBeUndefined();
  });
});

class Outer extends BaseClass {
  readonly input = new (class extends BaseClass { text = ""; })();
  result = "";
  reactions = 0;
  constructor(readonly wrong: boolean) {
    super();
    const react = () => { this.reactions++; };
    if (wrong) this.onUpdate(react);
    else this.input.onUpdate(react);
  }
}

describe("expectNoSelfWake", () => {
  it("fails a controller subscribed to the outer model", async () => {
    const model = new Outer(true);
    await expect(
      expectNoSelfWake(model.input, model, () => model.reactions, () => { model.result = "x"; }),
    ).rejects.toThrow(/reacted to its own write/);
  });

  it("passes a controller subscribed to input", async () => {
    const model = new Outer(false);
    await expect(
      expectNoSelfWake(model.input, model, () => model.reactions, () => { model.result = "x"; }),
    ).resolves.toBeUndefined();
  });
});

class BoolInput extends BaseClass { submitted = false as unknown as number }
class CounterInput extends BaseClass { submitCount = 0 }

describe("expectEdgeCounter", () => {
  it("fails a boolean flag, which cannot express two clicks in one tick", () => {
    const input = new BoolInput();
    expect(() => expectEdgeCounter(input as never, "submitted", () => 0)).toThrow(
      /must be a monotonic counter/,
    );
  });

  it("fails a counter whose observer collapses both edges", () => {
    const input = new CounterInput();
    let seen = 0;
    input.onUpdate(() => { seen += 1; }); // one pulse, both edges lost
    expect(() => expectEdgeCounter(input as never, "submitCount", () => seen)).toThrow(/lost an edge/);
  });

  it("passes a counter compared against a handled watermark", () => {
    const input = new CounterInput();
    let handled = 0;
    let observed = 0;
    input.onUpdate(() => {
      observed += input.submitCount - handled;
      handled = input.submitCount;
    });
    expect(() => expectEdgeCounter(input as never, "submitCount", () => observed)).not.toThrow();
  });
});

describe("probe", () => {
  it("counts only strict-equality changes, not every notify", () => {
    const model = new ListModel();
    const watcher = probe(model, () => model.items);
    model.notify();
    model.notify();
    expect(watcher.count).toBe(0);
    model.replace("a");
    expect(watcher.count).toBe(1);
    watcher.stop();
  });
});
