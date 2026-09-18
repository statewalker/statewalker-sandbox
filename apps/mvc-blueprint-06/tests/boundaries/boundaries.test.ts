/**
 * The boundary suite: who may import / do what, checked against the files. Every rule has a
 * negative control — a synthetic source that breaks it — so a rule that silently stops matching
 * fails too.
 */
import { describe, expect, it } from "vitest";
import {
  graph,
  imports,
  isBundle,
  isUiBundle,
  type Source,
  sources,
  stripComments,
  unitOf,
} from "../../scripts/graph.js";

const all = sources("src");
const REACT = /^(react|react-dom)(\/.*)?$/;

type Rule = { name: string; check(s: Source): string[] };

const rules: Rule[] = [
  {
    name: "R1 a bundle imports another bundle only through its API module",
    check: (s) => {
      const from = unitOf(s.file);
      if (!isBundle(from)) return [];
      return imports(s)
        .filter((i) => i.target)
        .map((i) => unitOf(`${i.target}.ts`))
        .filter((to) => to !== from && isBundle(to))
        .map((to) => `${s.file} → ${to}`);
    },
  },
  {
    name: "R2 a logic bundle, the kernel and the logic kit never import React or React-only modules",
    check: (s) => {
      const u = unitOf(s.file);
      if (isUiBundle(u) || u === "kit/react" || u === "app" || s.file.endsWith("api/react.ts"))
        return [];
      return imports(s)
        .filter(
          (i) =>
            REACT.test(i.spec) ||
            i.target?.endsWith("api/react") ||
            i.target?.startsWith("src/kit/react"),
        )
        .map((i) => `${s.file} imports ${i.spec}`);
    },
  },
  {
    name: "R3 a renderer file (views.tsx) has value imports only from React and the React kit",
    check: (s) => {
      if (!/\.ui\.react\/views\.tsx$/.test(s.file)) return [];
      return imports(s)
        .filter((i) => !i.typeOnly && !REACT.test(i.spec) && !i.target?.startsWith("src/kit/react"))
        .map((i) => `${s.file} value-imports ${i.spec}`);
    },
  },
  {
    name: "R4 an API module declares only: no function, class, or `new`",
    check: (s) => {
      if (!unitOf(s.file).startsWith("api:")) return [];
      return /\bfunction\b|\bclass\b|\bnew\s/.test(s.code)
        ? [`${s.file} implements something`]
        : [];
    },
  },
  {
    name: "R5 no module-level mutable state in bundles, APIs or kits (top-level let/var, new Map/Set, mutable array)",
    check: (s) => {
      const u = unitOf(s.file);
      if (u === "kernel" || u === "app") return [];
      const hits = [
        ...s.code.matchAll(/^(?:export\s+)?(?:let|var)\s+\w+/gm),
        ...s.code.matchAll(
          /^(?:export\s+)?const\s+\w+[^=\n]*=\s*new\s+(?:Map|Set|WeakMap|WeakSet|Array)\b/gm,
        ),
        ...s.code.matchAll(
          /^(?:export\s+)?const\s+\w+(?:\s*:\s*(?![^=\n]*readonly)[^=\n]+)?\s*=\s*\[(?![^;]*\]\s*as\s+const)/gm,
        ),
      ];
      return hits.map((m) => `${s.file}: ${m[0]}`);
    },
  },
  {
    name: "R6 only the host (shell.react) opens a view port or touches the DOM / globals",
    check: (s) => {
      const u = unitOf(s.file);
      if (u === "shell.react" || u === "app" || u === "kernel") return [];
      const hits = [
        ...s.code.matchAll(
          /\bviewPort\s*\(|\bdocument\.|\bwindow\.|\bglobalThis\b|\blocalStorage\b/g,
        ),
      ];
      return hits.map((m) => `${s.file}: ${m[0]}`);
    },
  },
  {
    name: "R7 a renderer never sends outside its props: no kernel calls (send/ask/publish/contribute)",
    check: (s) => {
      if (!/\.ui\.react\/views\.tsx$/.test(s.file)) return [];
      const hits = [
        ...s.code.matchAll(/\b(?:ctx|system)\.|\bcontribute\s*\(|\bpublish\s*\(|\bask\s*\(/g),
      ];
      return hits.map((m) => `${s.file}: ${m[0]}`);
    },
  },
];

const controls: Record<string, Source> = {
  R1: {
    file: "src/bundles/todos.list/index.ts",
    code: 'import { x } from "../todos.core/index.js";',
  },
  R2: { file: "src/bundles/todos.list/index.ts", code: 'import { useState } from "react";' },
  R3: {
    file: "src/bundles/todos.ui.react/views.tsx",
    code: 'import { listKind } from "../todos/api/index.js";',
  },
  R4: { file: "src/bundles/todos/api/index.ts", code: "export function helper() { return 1; }" },
  R5: {
    file: "src/bundles/todos.list/index.ts",
    code: "let counter = 0;\nexport const cache = new Map();\nconst list: string[] = [];",
  },
  R6: {
    file: "src/bundles/todos.list/index.ts",
    code: "const port = ctx.viewPort();\ndocument.title = 'x';",
  },
  R7: { file: "src/bundles/todos.ui.react/views.tsx", code: "ctx.send('todos.core', {});" },
};

describe("boundaries", () => {
  for (const rule of rules) {
    const id = rule.name.slice(0, 2);
    it(rule.name, () => {
      expect(all.flatMap((s) => rule.check(s))).toEqual([]);
    });
    it(`${id} negative control: a violating source is caught`, () => {
      const control = controls[id];
      expect(control).toBeDefined();
      expect(
        rule.check({ ...(control as Source), code: stripComments((control as Source).code) })
          .length,
      ).toBeGreaterThan(0);
    });
  }

  it("dependency graph: every cross-bundle edge targets an API module", () => {
    const g = graph(all);
    expect(g.violations).toEqual([]);
    expect(g.crossBundleEdges).toBe(g.toApi);
    expect(g.bundles.length).toBeGreaterThan(10);
  });
});
