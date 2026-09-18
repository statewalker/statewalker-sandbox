import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs helper shared with scripts/
import { bundleOf, imports, resolve, sources, unitOf } from "../../scripts/graph.mjs";

/**
 * The boundary suite (§13.2 / §13.3). Each rule is a function from a source file to its violations;
 * every rule runs on the app AND on a synthetic violating file (its negative control).
 */
interface Source {
  file: string;
  code: string;
}
type Rule = (s: Source) => string[];

const isRenderer = (f: string) => /^src\/bundles\/[^/]+\.ui\.react\//.test(f);
const isRendererContribution = (f: string) =>
  /^src\/bundles\/[^/]+\.ui\.react\/index\.tsx?$/.test(f);
const isHost = (f: string) => f.startsWith("src/bundles/shell.react/");
const isApi = (f: string) => /^src\/bundles\/[^/]+\/api\//.test(f);
/** `shell/api/react.ts` is the per-technology API sub-module (§6): React types by design. */
const isTechApi = (f: string) => /\/api\/react\.ts$/.test(f);
const isLogic = (f: string) =>
  f.startsWith("src/bundles/") && !isRenderer(f) && !isHost(f) && !isTechApi(f);
const UI_LIB = /^(react|react-dom)(\/|$)/;

const rules: Record<string, Rule> = {
  /** R1: a renderer value-imports only React, the React kit, and its own folder (types from API modules are fine). */
  "renderer imports no service, intent, log, model implementation or controller": ({
    file,
    code,
  }) => {
    if (!isRenderer(file) || isRendererContribution(file)) return [];
    return imports(code)
      .filter(({ spec, typeOnly }: { spec: string; typeOnly: boolean }) => {
        if (typeOnly || UI_LIB.test(spec)) return false;
        const target = resolve(file, spec);
        if (!target) return true;
        const unit = unitOf(target);
        return unit !== "kit/react" && unit !== unitOf(file);
      })
      .map(({ spec }: { spec: string }) => spec);
  },
  /** R2: views never publish or append at runtime. */
  "renderer never appends, requests, provides or registers": ({ file, code }) => {
    if (!isRenderer(file) || isRendererContribution(file)) return [];
    return [...code.matchAll(/\.\s*(append|request|provide|register|handle|project)\s*\(/g)].map(
      (m) => m[0],
    );
  },
  /** R3: a logic bundle imports no UI library and no .tsx. */
  "logic bundle imports no UI library": ({ file, code }) => {
    if (!isLogic(file)) return [];
    if (file.endsWith(".tsx")) return [file];
    return imports(code)
      .map(({ spec }: { spec: string }) => spec)
      .filter((spec: string) => UI_LIB.test(spec));
  },
  /** R4: every cross-bundle import targets an API module. */
  "cross-bundle imports target API modules only": ({ file, code }) => {
    if (!file.startsWith("src/bundles/")) return [];
    const from = unitOf(file);
    return imports(code)
      .map(({ spec }: { spec: string }) => ({ spec, target: resolve(file, spec) }))
      .filter(({ target }: { target?: string }) => target?.startsWith("src/bundles/"))
      .filter(({ target }: { target: string }) => {
        const to = unitOf(target);
        return bundleOf(to) !== bundleOf(from) && !to.endsWith("/api");
      })
      .map(({ spec }: { spec: string }) => spec);
  },
  /** R5: an API module holds declarations only — no handler, projection, log scope or slot write. */
  "API modules are declarations only": ({ file, code }) => {
    if (!isApi(file)) return [];
    return [
      ...code.matchAll(
        /\b(openLog|getIntentLog|\.handle\(|\.project\(|\.append\(|\.provide\(|\.register\()/g,
      ),
    ].map((m) => m[0]);
  },
  /** R6: only the kit's model substrate names the signals library. */
  "signals library stays private to the kit": ({ file, code }) => {
    if (file === "src/kit/alien-cell.ts") return [];
    return imports(code)
      .map(({ spec }: { spec: string }) => spec)
      .filter((spec: string) => /^alien-signals/.test(spec));
  },
};

const NEGATIVE: Record<string, Source> = {
  "renderer imports no service, intent, log, model implementation or controller": {
    file: "src/bundles/todos.ui.react/bad.tsx",
    code: 'import { addTodo } from "../todos/api/index.js";\nimport { openLog } from "../../kernel/log.js";',
  },
  "renderer never appends, requests, provides or registers": {
    file: "src/bundles/todos.ui.react/bad.tsx",
    code: "log.append(addTodo, { title });",
  },
  "logic bundle imports no UI library": {
    file: "src/bundles/todos.list/bad.ts",
    code: 'import { useState } from "react";',
  },
  "cross-bundle imports target API modules only": {
    file: "src/bundles/todos.contacts-link/bad.ts",
    code: 'import { activate } from "../contacts.list/index.js";',
  },
  "API modules are declarations only": {
    file: "src/bundles/todos/api/bad.ts",
    code: "const log = openLog(context, 'x'); log.handle(addTodo, () => {});",
  },
  "signals library stays private to the kit": {
    file: "src/bundles/todos.core/bad.ts",
    code: 'import { signal } from "alien-signals";',
  },
};

const all: Source[] = sources("src");

describe("boundaries", () => {
  for (const [name, rule] of Object.entries(rules)) {
    it(`${name}: 0 violations`, () => {
      const hits = all.flatMap((s) => rule(s).map((h) => `${s.file}: ${h}`));
      expect(hits).toEqual([]);
    });
    it(`${name}: negative control flags a violation`, () => {
      const control = NEGATIVE[name];
      if (!control) throw new Error(`no negative control for ${name}`);
      expect(rule(control).length).toBeGreaterThan(0);
    });
  }
  it("the suite covers renderers and logic bundles (the walk is not empty)", () => {
    expect(all.filter((s) => isRenderer(s.file)).length).toBeGreaterThan(4);
    expect(all.filter((s) => isLogic(s.file)).length).toBeGreaterThan(10);
  });
});

/** §13.2 "domain logic in views": the counted patterns in renderer files, listed for the report. */
describe("domain logic in views", () => {
  it("renderer files have no await, call, provide/register (outside the contribution file) or service import", () => {
    const hits = all
      .filter((s) => isRenderer(s.file))
      .flatMap((s) => {
        const found = [...s.code.matchAll(/\bawait\b|\.call\(/g)].map((m) => m[0]);
        if (!isRendererContribution(s.file)) {
          found.push(...[...s.code.matchAll(/\.(provide|register)\(/g)].map((m) => m[0]));
        }
        found.push(...[...s.code.matchAll(/\bget[A-Z]\w*Api\b|\bopenLog\b/g)].map((m) => m[0]));
        return found.map((h) => `${s.file}: ${h}`);
      });
    expect(hits).toEqual([]);
  });
});
