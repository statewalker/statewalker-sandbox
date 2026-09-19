import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROOT,
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
const bundleName = (file: string) => /^packages\/bundles\/([^/]+)\//.exec(file)?.[1];
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
  /^(?:react|react\/jsx-runtime|solid-js|solid-js\/web|@p5\/kit-react|@p5\/kit-solid|\.\/.*)$/;
const rendererViolations = (s: Source) =>
  s.imports.filter((i) => !i.typeOnly && !RENDERER_VALUE_OK.test(i.spec)).map((i) => i.spec);

/** R2: a renderer never publishes, fires, listens or awaits (ARCHITECTURE §9). */
const RENDERER_RUNTIME =
  /\.\s*(?:provide|register|call|listen)\s*\(|\b(?:call|answer)\s*\(|\bawait\b/g;

/** R3: a logic bundle or a neutral API module imports no UI library or UI module. */
const UI_SPEC =
  /^(?:react|react-dom)(?:\/|$)|^solid-js(?:\/|$)|^@p5\/kit-(?:react|solid)$|^@p5\/shell\/api\/(?:react|solid)$|\.ui\.|^@p5\/shell\.(?:react|solid|test)/;
/** R4: logic code never reads the DOM. */
const DOM_GLOBAL = /\b(?:document|window|HTMLElement|localStorage)\b/;

/** R6: the kernel imports no bundle and no kit. */
const KERNEL_FORBIDDEN = /^@p5\//;
/** R7: the substrate stays private. */
const ALIEN = /^alien-signals(?:\/|$)/;
const KIT_SIGNALS = /^@p5\/kit-signals$/;
const mayImportSignals = (file: string) =>
  /^packages\/kits\/(?:model|commit|form|track)\//.test(file) || /\.model\.ts$/.test(file);
/** R8: an API module declares; it implements nothing. */
const IMPLEMENTATION = /\bfunction\b|\bclass\b|\bnew\s+[A-Z]/;
const API_VALUE_OK = /^@p5\/kernel$/;

/** R9: the `<app>:api` service adapters declared in API modules, owned by `<app>.core` (D10). Host services (`shell:*`) are set by hosts. */
const SERVICES = new Map(
  apiFiles.flatMap((s) =>
    [...s.code.matchAll(/export const (\w+)\s*=\s*newAdapter<[^>]*>\("[\w.-]+:api"\)/g)].map(
      (m) => [m[1], `${bundleName(s.file)}.core`] as const,
    ),
  ),
);
const serviceViolations = (s: Source) => {
  const bundle = bundleName(s.file);
  if (!bundle || isApi(s)) return [];
  return [...SERVICES]
    .filter(([name, owner]) => bundle !== owner && new RegExp(`\\b${name}\\b`).test(s.code))
    .map(([name]) => `${s.file} uses ${name}`);
};

/** R10 (R2's rule, extended to the kernel): top-level let/var, new Map/Set/Array, mutable array. WeakMap/WeakSet are allowed: keyed by per-application objects. */
const moduleState = (s: Source) =>
  [
    ...s.code.matchAll(/^(?:export\s+)?(?:let|var)\s+\w+/gm),
    ...s.code.matchAll(/^(?:export\s+)?const\s+\w+[^=\n]*=\s*new\s+(?:Map|Set|Array)\b/gm),
    ...s.code.matchAll(
      /^(?:export\s+)?const\s+\w+(?:\s*:\s*(?![^=\n]*readonly)[^=\n]+)?\s*=\s*\[(?![^;]*\]\s*as\s+const)/gm,
    ),
  ].map((m) => `${s.file}: ${m[0]}`);

/** R11: controller files — a logic bundle's activator module. */
const controllerFiles = logicFiles.filter((s) => s.file.endsWith("/index.ts"));
const bareAwaits = (code: string) =>
  [...code.matchAll(/\bawait\s+(?!(?:\w+\.)?task\()[^;\n]*/g)].map((m) => m[0]);

/** R12: the package graph (D13), from each package.json. */
function packageJsons(): { dir: string; name: string; deps: string[] }[] {
  const out: { dir: string; name: string; deps: string[] }[] = [];
  const add = (dir: string) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
    out.push({ dir, name: pkg.name, deps: Object.keys(pkg.dependencies ?? {}) });
  };
  add("packages/kernel");
  for (const group of ["kits", "bundles"])
    for (const n of readdirSync(join(ROOT, "packages", group))) add(`packages/${group}/${n}`);
  return out;
}
const pkgName = (spec: string) => spec.split("/").slice(0, 2).join("/");
function undeclared(): string[] {
  const pkgs = packageJsons();
  return all.flatMap((s) => {
    const pkg = pkgs.find((p) => s.file.startsWith(`${p.dir}/`));
    if (!pkg) return [];
    return s.imports
      .map((i) => pkgName(i.spec))
      .filter((n) => n.startsWith("@p5/") && n !== pkg.name && !pkg.deps.includes(n))
      .map((n) => `${s.file} imports ${n}, not in ${pkg.dir}/package.json`);
  });
}
export function cycleIn(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const state = new Map<string, "on" | "done">();
  const visit = (n: string, path: string[]): string[] | undefined => {
    if (state.get(n) === "on") return [...path.slice(path.indexOf(n)), n];
    if (state.get(n) === "done") return undefined;
    state.set(n, "on");
    for (const d of graph.get(n) ?? []) {
      const found = visit(d, [...path, n]);
      if (found) return found;
    }
    state.set(n, "done");
    return undefined;
  };
  for (const n of graph.keys()) {
    const found = visit(n, []);
    if (found) return found;
  }
  return undefined;
}
const packageCycle = () =>
  cycleIn(new Map(packageJsons().map((p) => [p.name, p.deps.filter((d) => d.startsWith("@p5/"))])));

describe("boundary suite", () => {
  it("finds the tree it polices", () => {
    expect(logicFiles.length).toBeGreaterThan(15);
    expect(apiFiles.length).toBeGreaterThanOrEqual(5);
    expect(rendererFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("R1 renderers value-import only React, the binding kits and their own files", () => {
    for (const s of rendererFiles) expect(rendererViolations(s), s.file).toEqual([]);
  });

  it("R2 renderers never provide, register, call, listen or await", () => {
    for (const s of rendererFiles) expect(s.code.match(RENDERER_RUNTIME) ?? [], s.file).toEqual([]);
  });

  it("R3 logic bundles and neutral API modules import no UI library", () => {
    const neutral = apiFiles.filter((s) => !/\/api\/(react|solid)\//.test(s.file));
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
    for (const s of all.filter((x) => x.file.startsWith("packages/kernel/"))) {
      for (const i of s.imports)
        expect(KERNEL_FORBIDDEN.test(i.spec), `${s.file} → ${i.spec}`).toBe(false);
    }
  });

  it("R7 alien-signals only in kits/signals; @kit/signals only in the model kit and *.model.ts", () => {
    const alien = all.filter((s) => s.imports.some((i) => ALIEN.test(i.spec))).map((s) => s.file);
    expect(alien).toEqual(["packages/kits/signals/index.ts"]);
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

  it("R9 a service an API declares is used only by its owner bundle (`<app>.core`)", () => {
    const bad = all.flatMap((s) => serviceViolations(s));
    expect(bad).toEqual([]);
    expect(SERVICES.size).toBeGreaterThanOrEqual(2); // todos:api, contacts:api
  });

  it("R10 no module-level mutable state anywhere (kernel, kits, bundles, APIs)", () => {
    const hits = all.filter((s) => s.file.startsWith("packages/")).flatMap(moduleState);
    expect(hits).toEqual([]);
  });

  it("R11 a controller awaits only through a scope (`task(…)`): no 'still active?' check needed", () => {
    for (const s of controllerFiles) expect(bareAwaits(s.code), s.file).toEqual([]);
  });

  it("R12 every @p5 import is a declared dependency of its package; the package graph is acyclic", () => {
    expect(undeclared()).toEqual([]);
    expect(packageCycle()).toBeUndefined();
  });

  describe("negative controls: every rule can fail", () => {
    it("R1", () => {
      const bad = {
        file: "x",
        code: "",
        imports: importsOf(
          'import { todosAdd } from "@p5/todos/api";\nimport { getSlots } from "@p5/kernel";',
        ),
      };
      expect(rendererViolations(bad)).toEqual(["@p5/todos/api", "@p5/kernel"]);
      const good = {
        file: "x",
        code: "",
        imports: importsOf(
          'import type { TodoListView } from "@p5/todos/api";\nimport { useModel } from "@p5/kit-react";',
        ),
      };
      expect(rendererViolations(good)).toEqual([]);
    });
    it("R2", () => {
      expect("slots.provide(x, y)".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("commands . call(todosAdd, {})".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("call(slots, todosAdd, {})".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("answer(slots, todosAdd, f)".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("await x".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("model.save.submit()".match(RENDERER_RUNTIME)).toBeNull();
    });
    it("R3", () => {
      for (const bad of [
        "react",
        "react-dom/client",
        "@p5/kit-react",
        "@p5/shell/api/solid",
        "@p5/todos.ui.react",
        "@p5/shell.react",
      ]) {
        expect(UI_SPEC.test(bad), bad).toBe(true);
      }
      for (const good of [
        "@p5/kernel",
        "@p5/kit-model",
        "@p5/shell/api",
        "@p5/todos/api",
        "reactive",
      ]) {
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
          file: "packages/bundles/todos.status/index.ts",
          code: "",
          imports: importsOf(
            'import { x } from "@p5/todos.core";\nimport { y } from "@p5/todos/api";',
          ),
        },
      ];
      const found = crossBundle(edges(fake));
      expect(found.map((f) => [f.edge.spec, f.ok])).toEqual([
        ["@p5/todos.core", false],
        ["@p5/todos/api", true],
      ]);
      expect(ownerOf(moduleOf("packages/bundles/hello/api/index.ts"))).toBe("bundle:hello");
      expect(resolve("packages/bundles/hello/index.ts", "./api/index.js").path).toBe(
        "packages/bundles/hello/api/index.js",
      );
    });
    it("R9, R10, R11, R12", () => {
      const fake = (file: string, code: string): Source => ({
        file,
        code,
        imports: importsOf(code),
      });
      expect(
        serviceViolations(fake("packages/bundles/todos.list/index.ts", "todoApiAdapter.get(ctx)")),
      ).toHaveLength(1);
      expect(
        serviceViolations(fake("packages/bundles/todos.core/index.ts", "todoApiAdapter.get(ctx)")),
      ).toEqual([]);
      expect(moduleState(fake("packages/kits/x/index.ts", "let seq = 0;"))).toHaveLength(1);
      expect(moduleState(fake("packages/kits/x/index.ts", "const m = new Map();"))).toHaveLength(1);
      expect(moduleState(fake("packages/kits/x/index.ts", "const w = new WeakMap();"))).toEqual([]);
      expect(moduleState(fake("packages/kits/x/index.ts", "  let inside = 0;"))).toEqual([]);
      expect(bareAwaits("await call(slots, x, p).promise;")).toHaveLength(1);
      expect(bareAwaits("await task(p); await scope.task(q); await turn.task(r);")).toEqual([]);
      expect(
        cycleIn(
          new Map([
            ["a", ["b"]],
            ["b", ["a"]],
          ]),
        ),
      ).toEqual(["a", "b", "a"]);
      expect(
        cycleIn(
          new Map([
            ["a", ["b"]],
            ["b", []],
          ]),
        ),
      ).toBeUndefined();
    });
    it("R6, R7, R8", () => {
      expect(KERNEL_FORBIDDEN.test("@p5/shell/api")).toBe(true);
      expect(KERNEL_FORBIDDEN.test("@statewalker/shared-slots")).toBe(false);
      expect(ALIEN.test("alien-signals")).toBe(true);
      expect(mayImportSignals("packages/bundles/todos.list/index.ts")).toBe(false);
      expect(mayImportSignals("packages/bundles/todos.list/list.model.ts")).toBe(true);
      expect("export function f() {}").toMatch(IMPLEMENTATION);
      expect("new MemTodoApi()").toMatch(IMPLEMENTATION);
      expect("export const x = defineCommand<A, B>('a')").not.toMatch(IMPLEMENTATION);
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
    const pkgs = packageJsons();
    const internal = pkgs.flatMap((p) => p.deps.filter((d) => d.startsWith("@p5/")));
    lines.push(
      `package graph (D13): ${pkgs.length} packages, ${internal.length} declared @p5 dependencies, acyclic: ${packageCycle() === undefined}`,
    );
    console.info(`[graph]\n${lines.join("\n")}`);
    expect(cross.filter((c) => !c.ok)).toEqual([]);
  });
});
