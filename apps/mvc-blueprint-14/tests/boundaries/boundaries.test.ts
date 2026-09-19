import { describe, expect, it } from "vitest";
import {
  crossBundle,
  edges,
  importsOf,
  isRendererBundle,
  isUiBundle,
  moduleOf,
  ownerOf,
  resolve,
  type Source,
  sources,
} from "./graph.js";

const all = sources();
const bundleName = (file: string) => /^src\/bundles\/([^/]+)\//.exec(file)?.[1];
const inBundle = (s: Source) => bundleName(s.file) !== undefined;
const isApi = (s: Source) => moduleOf(s.file).startsWith("api:");
const logicFiles = all.filter(
  (s) => inBundle(s) && !isApi(s) && !isUiBundle(bundleName(s.file) as string),
);
const apiFiles = all.filter(isApi);
/** A renderer file: in a `*.ui.*` bundle, other than its contribution file `index.ts`. */
const rendererFiles = all.filter(
  (s) => isRendererBundle(bundleName(s.file) ?? "") && !s.file.endsWith("/index.ts"),
);

// ── the rules, as predicates (each has a negative control below) ─────────────────────────────
/** R1: what a renderer may value-import. Types from API modules and the kernel are fine. */
const RENDERER_VALUE_OK =
  /^(?:react|react\/jsx-runtime|@kit\/react|@kit\/dom|@json-render\/react|\.\/.*)$/; // J1: + @json-render/react
const rendererViolations = (s: Source) =>
  s.imports.filter((i) => !i.typeOnly && !RENDERER_VALUE_OK.test(i.spec)).map((i) => i.spec);

/** R2: a renderer never publishes, fires, listens or awaits (ARCHITECTURE §9). */
const RENDERER_RUNTIME = /\.\s*(?:provide|register|call|listen)\s*\(|\bawait\b/g;

/** R3: a logic bundle or a neutral API module imports no UI library or UI module. */
const UI_SPEC =
  /^(?:react|react-dom)(?:\/|$)|^@kit\/(?:react|dom)$|^@b\/shell\/api\/(?:react|dom)$|\.ui\.|^@b\/shell\.(?:react|dom|test)/;
/** R4: logic code never reads the DOM. */
const DOM_GLOBAL = /\b(?:document|window|HTMLElement|localStorage)\b/;

/** R6: the kernel imports no bundle and no kit. */
const KERNEL_FORBIDDEN = /^@(?:b|kit)\//;
/** R7: the substrate stays private. */
const ALIEN = /^alien-signals(?:\/|$)/;
const KIT_SIGNALS = /^@kit\/signals$/;
const mayImportSignals = (file: string) =>
  file.startsWith("src/kits/model/") ||
  file.startsWith("src/kits/commit/") || // P3: the commit-record action is a model kit
  /\.model\.ts$/.test(file);
/** R8: an API module declares; it implements nothing. */
const IMPLEMENTATION = /\bfunction\b|\bclass\b|\bnew\s+[A-Z]/;
const API_VALUE_OK = /^@kernel$/;

describe("boundary suite", () => {
  it("finds the tree it polices", () => {
    expect(logicFiles.length).toBeGreaterThan(15);
    expect(apiFiles.length).toBe(9); // J1: + catalog/api, catalog/api/react, agent/api
    expect(rendererFiles.length).toBe(8); // J1: + catalog, agent and badge React files
  });

  it("R1 renderers value-import only React, the binding kits and their own files", () => {
    for (const s of rendererFiles) expect(rendererViolations(s), s.file).toEqual([]);
  });

  it("R2 renderers never provide, register, call, listen or await", () => {
    for (const s of rendererFiles) expect(s.code.match(RENDERER_RUNTIME) ?? [], s.file).toEqual([]);
  });

  it("R3 logic bundles and neutral API modules import no UI library", () => {
    const neutral = apiFiles.filter((s) => !/\/api\/(react|dom)\//.test(s.file));
    for (const s of [...logicFiles, ...neutral]) {
      for (const i of s.imports)
        expect(UI_SPEC.test(i.spec), `${s.file} imports ${i.spec}`).toBe(false);
    }
  });

  it("R4 logic bundles never touch the DOM", () => {
    for (const s of logicFiles) expect(s.code, s.file).not.toMatch(DOM_GLOBAL);
  });

  it("R5 every cross-bundle edge targets an API module", () => {
    const bad = crossBundle(edges(all)).filter((e) => !e.ok);
    expect(bad.map((b) => `${b.edge.file} → ${b.edge.spec}`)).toEqual([]);
  });

  it("R6 the kernel imports no bundle and no kit", () => {
    for (const s of all.filter((x) => x.file.startsWith("src/kernel/"))) {
      for (const i of s.imports)
        expect(KERNEL_FORBIDDEN.test(i.spec), `${s.file} → ${i.spec}`).toBe(false);
    }
  });

  it("R7 alien-signals only in kits/signals; @kit/signals only in the model kit and *.model.ts", () => {
    const alien = all.filter((s) => s.imports.some((i) => ALIEN.test(i.spec))).map((s) => s.file);
    expect(alien).toEqual(["src/kits/signals/index.ts"]);
    for (const s of all.filter((x) => x.imports.some((i) => KIT_SIGNALS.test(i.spec)))) {
      expect(mayImportSignals(s.file), s.file).toBe(true);
    }
  });

  it("R8 API modules hold declarations only", () => {
    for (const s of apiFiles) {
      expect(s.code, s.file).not.toMatch(IMPLEMENTATION);
      for (const i of s.imports.filter((x) => !x.typeOnly)) {
        expect(API_VALUE_OK.test(i.spec), `${s.file} value-imports ${i.spec}`).toBe(true);
      }
    }
  });

  describe("negative controls: every rule can fail", () => {
    it("R1", () => {
      const bad = {
        file: "x",
        code: "",
        imports: importsOf(
          'import { todosAdd } from "@b/todos/api";\nimport { getSlots } from "@kernel";',
        ),
      };
      expect(rendererViolations(bad)).toEqual(["@b/todos/api", "@kernel"]);
      const good = {
        file: "x",
        code: "",
        imports: importsOf(
          'import type { TodoListView } from "@b/todos/api";\nimport { useModel } from "@kit/react";',
        ),
      };
      expect(rendererViolations(good)).toEqual([]);
    });
    it("R2", () => {
      expect("slots.provide(x, y)".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("commands . call(todosAdd, {})".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("await x".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("model.save.submit()".match(RENDERER_RUNTIME)).toBeNull();
    });
    it("R3", () => {
      for (const bad of [
        "react",
        "react-dom/client",
        "@kit/react",
        "@b/shell/api/dom",
        "@b/todos.ui.react",
        "@b/shell.react",
      ]) {
        expect(UI_SPEC.test(bad), bad).toBe(true);
      }
      for (const good of ["@kernel", "@kit/model", "@b/shell/api", "@b/todos/api", "reactive"]) {
        expect(UI_SPEC.test(good), good).toBe(false);
      }
    });
    it("R4", () => {
      expect("document.body").toMatch(DOM_GLOBAL);
      expect("const el: HTMLElement").toMatch(DOM_GLOBAL);
      expect("documented").not.toMatch(DOM_GLOBAL);
    });
    it("R5", () => {
      const fake: Source[] = [
        {
          file: "src/bundles/todos.status/index.ts",
          code: "",
          imports: importsOf(
            'import { x } from "@b/todos.core";\nimport { y } from "@b/todos/api";',
          ),
        },
      ];
      const found = crossBundle(edges(fake));
      expect(found.map((f) => [f.edge.spec, f.ok])).toEqual([
        ["@b/todos.core", false],
        ["@b/todos/api", true],
      ]);
      expect(ownerOf(moduleOf("src/bundles/hello/api/index.ts"))).toBe("bundle:hello");
      expect(resolve("src/bundles/hello/index.ts", "./api/index.js").path).toBe(
        "src/bundles/hello/api/index.js",
      );
    });
    it("R6, R7, R8", () => {
      expect(KERNEL_FORBIDDEN.test("@b/shell/api")).toBe(true);
      expect(KERNEL_FORBIDDEN.test("@statewalker/shared-slots")).toBe(false);
      expect(ALIEN.test("alien-signals")).toBe(true);
      expect(mayImportSignals("src/bundles/todos.list/index.ts")).toBe(false);
      expect(mayImportSignals("src/bundles/todos.list/list.model.ts")).toBe(true);
      expect("export function f() {}").toMatch(IMPLEMENTATION);
      expect("new MemTodoApi()").toMatch(IMPLEMENTATION);
      expect("export const x = Command.required('a')").not.toMatch(IMPLEMENTATION);
      expect(API_VALUE_OK.test("zod")).toBe(false);
    });
  });
});

describe("dependency graph report (§13.3)", () => {
  it("prints bundle → module edges; 0 violations", () => {
    const cross = crossBundle(edges(all));
    const fanOut = new Map<string, Set<string>>();
    for (const e of edges(all)) {
      if (!e.from.startsWith("bundle:")) continue;
      const set = fanOut.get(e.from) ?? new Set();
      set.add(e.to);
      fanOut.set(e.from, set);
    }
    const unique = new Set(cross.map((c) => `${c.edge.from} → ${c.edge.to}`));
    const lines = [
      `cross-bundle edges (import sites): ${cross.length}, distinct: ${unique.size}`,
      `to API modules: ${cross.filter((c) => c.ok).length}`,
      `violations: ${cross.filter((c) => !c.ok).length}`,
      "fan-out per bundle (distinct modules outside the bundle):",
      ...[...fanOut]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([b, t]) =>
            `  ${b.padEnd(32)} ${String(t.size).padStart(2)}  ${[...t].sort().join(", ")}`,
        ),
    ];
    console.info(`[graph]\n${lines.join("\n")}`);
    expect(cross.filter((c) => !c.ok)).toEqual([]);
  });
});
