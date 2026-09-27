// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §3 (filter, evaluate,
// then sort; navigation first, groups lexicographic, order ascending,
// contribution order as tiebreak; "does not cache")
// DERIVED-FROM-NOTE: 08-The Prototype Ladder.md §6 (render-time `when`,
// cross-app contribution — rung 5's property reached at rung 1)

import { describe, expect, it } from "vitest";
import {
  getEnablement,
  getSlots,
  type HostContext,
  newAppContext,
  newShellContext,
} from "../src/context.js";
import { fact } from "../src/enablement.js";
import { resolveMenu } from "../src/menu.js";
import { type MenuItem, menuItemsSlot } from "../src/slots.js";

function contribute(ctx: HostContext, ...items: MenuItem[]) {
  const slots = getSlots(ctx);
  for (const item of items) slots.provide(menuItemsSlot, item);
}

const keys = (items: MenuItem[]) => items.map((i) => i.command);

describe("filtering", () => {
  it("returns only the entries for the requested location", () => {
    const shell = newShellContext();
    contribute(
      shell,
      { location: "explorer:context", command: "a" },
      { location: "editor:title", command: "b" },
    );
    expect(keys(resolveMenu(shell, "explorer:context"))).toEqual(["a"]);
    expect(keys(resolveMenu(shell, "editor:title"))).toEqual(["b"]);
    expect(resolveMenu(shell, "nobody:declared:this")).toEqual([]);
  });
});

describe("ordering", () => {
  it("pins `navigation` above every other group, whenever it was contributed", () => {
    const shell = newShellContext();
    contribute(
      shell,
      { location: "l", command: "alpha", group: "alpha" },
      { location: "l", command: "nav", group: "navigation" },
    );
    expect(keys(resolveMenu(shell, "l"))).toEqual(["nav", "alpha"]);
  });

  it("sorts remaining groups lexicographically", () => {
    const shell = newShellContext();
    contribute(
      shell,
      { location: "l", command: "z", group: "zeta" },
      { location: "l", command: "m", group: "modify" },
      { location: "l", command: "c", group: "compare" },
    );
    expect(keys(resolveMenu(shell, "l"))).toEqual(["c", "m", "z"]);
  });

  it("sorts by `order` ascending within a group", () => {
    const shell = newShellContext();
    contribute(
      shell,
      { location: "l", command: "third", group: "g", order: 30 },
      { location: "l", command: "first", group: "g", order: 10 },
      { location: "l", command: "second", group: "g", order: 20 },
    );
    expect(keys(resolveMenu(shell, "l"))).toEqual(["first", "second", "third"]);
  });

  it("uses contribution order as the final tiebreak", () => {
    const shell = newShellContext();
    contribute(
      shell,
      { location: "l", command: "one", group: "g" },
      { location: "l", command: "two", group: "g" },
      { location: "l", command: "three", group: "g" },
    );
    expect(keys(resolveMenu(shell, "l"))).toEqual(["one", "two", "three"]);
  });

  it("`order` does not leak across groups", () => {
    const shell = newShellContext();
    contribute(
      shell,
      { location: "l", command: "late-in-a", group: "a", order: 99 },
      { location: "l", command: "early-in-b", group: "b", order: 1 },
    );
    expect(keys(resolveMenu(shell, "l"))).toEqual(["late-in-a", "early-in-b"]);
  });

  it("places ungrouped entries below navigation and above named groups", () => {
    const shell = newShellContext();
    contribute(
      shell,
      { location: "l", command: "named", group: "aaa" },
      { location: "l", command: "loose" },
      { location: "l", command: "nav", group: "navigation" },
    );
    expect(keys(resolveMenu(shell, "l"))).toEqual(["nav", "loose", "named"]);
  });
});

describe("render-time `when`", () => {
  it("a contribution registered once, unconditionally, appears and disappears as facts change", () => {
    const shell = newShellContext();
    contribute(shell, {
      location: "explorer:context",
      command: "files:delete",
      when: 'selection("file")',
    });
    const enablement = getEnablement(shell);

    expect(resolveMenu(shell, "explorer:context")).toEqual([]);
    enablement.assert(fact("selection", "file"));
    expect(keys(resolveMenu(shell, "explorer:context"))).toEqual(["files:delete"]);
    enablement.retract(fact("selection", "file"));
    expect(resolveMenu(shell, "explorer:context")).toEqual([]);
  });

  it("does not cache — every call re-reads the slot and the fact set", () => {
    const shell = newShellContext();
    expect(resolveMenu(shell, "l")).toEqual([]);
    contribute(shell, { location: "l", command: "late" });
    expect(keys(resolveMenu(shell, "l"))).toEqual(["late"]);
    // A fresh array each time: the caller may sort or splice it freely.
    expect(resolveMenu(shell, "l")).not.toBe(resolveMenu(shell, "l"));
  });

  it("entries without a `when` are always enabled", () => {
    const shell = newShellContext();
    contribute(shell, { location: "l", command: "always" });
    expect(keys(resolveMenu(shell, "l"))).toEqual(["always"]);
  });

  it("propagates a malformed `when` rather than silently hiding the entry", () => {
    const shell = newShellContext();
    contribute(shell, {
      location: "l",
      command: "bad",
      when: 'a("x") || b("y")',
    });
    expect(() => resolveMenu(shell, "l")).toThrow(/Malformed when clause/);
  });
});

describe("cross-app contribution — rung 5's property, reached at rung 1", () => {
  it("app A contributes into app B's menu location by string key, without importing B", () => {
    const shell = newShellContext();
    const appA = newAppContext(shell, {
      id: "a",
      origin: "https://a.example/",
    });
    const appB = newAppContext(shell, {
      id: "b",
      origin: "http://localhost:7654/peer/12D3KooWxyz/b/",
    });

    // B declares a location simply by rendering one, and owns a command key.
    contribute(appB, {
      location: "b:toolbar",
      command: "b:refresh",
      group: "navigation",
    });
    // A names both, and has no reference to B of any kind.
    contribute(appA, {
      location: "b:toolbar",
      command: "b:refresh",
      group: "extra",
      args: { from: "a" },
    });

    const resolved = resolveMenu(shell, "b:toolbar");
    expect(keys(resolved)).toEqual(["b:refresh", "b:refresh"]);
    expect(resolved[1]?.args).toEqual({ from: "a" });
  });

  it("nothing validates that a menu entry's command key resolves — a known hole", () => {
    const shell = newShellContext();
    contribute(shell, { location: "l", command: "does:not:exist" });
    // Resolution succeeds. The dangling key is only discovered on invocation.
    expect(keys(resolveMenu(shell, "l"))).toEqual(["does:not:exist"]);
  });
});
