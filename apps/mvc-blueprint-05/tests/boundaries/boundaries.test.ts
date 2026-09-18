/** §13.2 boundary suite: every rule holds on src/, and every rule fails on a planted violation. */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs shared with scripts/deps.mjs
import { bundleGraph, check, edges, rules } from "../../scripts/graph.mjs";

type Edge = { from: string; to: string; external: boolean; names: string };
const planted: Record<string, Edge> = {
  "kernel imports no bundle": {
    from: "src/kernel/store.ts",
    to: "src/bundles/todos/api/index.ts",
    external: false,
    names: "",
  },
  "cross-bundle edges target API modules": {
    from: "src/bundles/todos.contacts-link/index.ts",
    to: "src/bundles/contacts.list/index.ts",
    external: false,
    names: "",
  },
  "API modules import only the kernel and API modules": {
    from: "src/bundles/todos/api/index.ts",
    to: "src/bundles/todos.core/mem-api.ts",
    external: false,
    names: "",
  },
  "logic bundles import no UI library": {
    from: "src/bundles/todos.list/index.ts",
    to: "react",
    external: true,
    names: "",
  },
  "renderers reach no store, api service or effect": {
    from: "src/bundles/todos.ui.react/views.tsx",
    to: "src/kernel/index.ts",
    external: false,
    names: " getStore ",
  },
};

describe("boundaries", () => {
  const list = edges() as Edge[];
  const violations = check(list) as Record<string, string[]>;

  it("sees the graph", () => {
    expect(list.length).toBeGreaterThan(50);
  });

  for (const name of Object.keys(rules)) {
    it(`holds: ${name}`, () => {
      expect(violations[name]).toEqual([]);
    });
    it(`negative control: ${name}`, () => {
      const edge = planted[name];
      expect(edge, `no planted violation for ${name}`).toBeDefined();
      expect((check([edge]) as Record<string, string[]>)[name]).toHaveLength(1);
    });
  }

  it("dependency graph: every cross-bundle edge targets an API module", () => {
    const g = bundleGraph(list);
    expect(g.violations).toEqual([]);
    expect(g.toApi).toBe(g.cross.length);
  });
});
