import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  crossBundle,
  edges,
  importsOf,
  isRendererBundle,
  isUiBundle,
  moduleOf,
  ownerOf,
  ROOT,
  resolve,
  type Source,
  sources,
} from "./graph.js";

/**
 * P0's/U1's boundary suite for J2. The renderers are gone: a view is a json-render spec (JSON)
 * plus a model binding (`*.ui.jr/bindings.ts`); a technology is a shell host plus `jr.<tech>` (the
 * catalog implementation and the views → renderers bridge). R1/R2 police the bindings (the only
 * code a view still has); R9 polices the two technologies; R10 the jr.<tech> bundles; R11 keeps
 * views technology-free; R12 keeps specs pure data.
 */
const all = sources();
const bundleName = (file: string) => /^src\/bundles\/([^/]+)\//.exec(file)?.[1];
const inBundle = (s: Source) => bundleName(s.file) !== undefined;
const isApi = (s: Source) => moduleOf(s.file).startsWith("api:");
const logicFiles = all.filter(
  (s) => inBundle(s) && !isApi(s) && !isUiBundle(bundleName(s.file) as string),
);
const apiFiles = all.filter(isApi);
/** A view file: in a `*.ui.*` bundle, other than its contribution file `index.ts` (= the bindings). */
const rendererFiles = all.filter(
  (s) => isRendererBundle(bundleName(s.file) ?? "") && !s.file.endsWith("/index.ts"),
);
const viewBundleFiles = all.filter((s) => isRendererBundle(bundleName(s.file) ?? ""));

// ── the rules, as predicates (each has a negative control below) ─────────────────────────────
/** R1: what a model binding may value-import: the jr kit and its own files. Types are fine. */
const RENDERER_VALUE_OK = /^(?:@kit\/jr|\.\/.*)$/;
const rendererViolations = (s: Source) =>
  s.imports.filter((i) => !i.typeOnly && !RENDERER_VALUE_OK.test(i.spec)).map((i) => i.spec);

/** R2: a view never publishes, fires, listens or awaits (ARCHITECTURE §9). */
const RENDERER_RUNTIME = /\.\s*(?:provide|register|call|listen)\s*\(|\bawait\b/g;

/** R3: a logic bundle or a neutral API module imports no UI library or UI module. */
const TECHS = ["react", "solid"] as const;
const UI_SPEC =
  /^(?:react|react-dom|solid-js|@json-render\/(?:react|solid))(?:\/|$)|^@kit\/(?:react|solid|jr)$|^@b\/shell\/api\/(?:react|solid|jr)$|\.ui\.|^@b\/shell\.(?:react|test|solid)|^@b\/jr\./;
/** R9: a technology's UI (kit, renderer API, host, jr bundle) imports no other technology. */
const TECH_OF: Record<(typeof TECHS)[number], RegExp> = {
  react:
    /^react(?:-dom)?(?:\/|$)|^@json-render\/react(?:\/|$)|^@kit\/react$|^@b\/shell\/api\/react$|^@b\/shell\.react$|^@b\/jr\.react$/,
  solid:
    /^solid-js(?:\/|$)|^@json-render\/solid(?:\/|$)|^@kit\/solid$|^@b\/shell\/api\/solid$|^@b\/shell\.solid$|^@b\/jr\.solid$/,
};
const techOfFile = (file: string) =>
  TECHS.find((t) =>
    new RegExp(
      `^src/(?:kits/${t}/|bundles/shell/api/${t}/|bundles/shell\\.${t}/|bundles/jr\\.${t}/)`,
    ).test(file),
  );
const foreignTech = (file: string, spec: string) => {
  const own = techOfFile(file);
  return own !== undefined && TECHS.some((t) => t !== own && TECH_OF[t].test(spec));
};
/** R4: logic code never reads the DOM. */
const DOM_GLOBAL = /\b(?:document|window|HTMLElement|localStorage)\b/;

/** R6: the kernel imports no bundle and no kit. */
const KERNEL_FORBIDDEN = /^@(?:b|kit)\//;
/** R7: the substrate stays private. */
const ALIEN = /^alien-signals(?:\/|$)/;
const KIT_SIGNALS = /^@kit\/signals$/;
const mayImportSignals = (file: string) =>
  file.startsWith("src/kits/model/") || /\.model\.ts$/.test(file);
/** R8: an API module declares; it implements nothing. */
const IMPLEMENTATION = /\bfunction\b|\bclass\b|\bnew\s+[A-Z]/;
const API_VALUE_OK = /^@kernel$/;

/** R10: a jr.<tech> bundle reaches only the renderer extension points. */
const JR_BUNDLE_OK = /^@b\/shell\/api\/(?:jr|react|solid)$/;
/** R11: views (specs + bindings) name no technology: no UI library, no technology module. */
const TECHNOLOGY =
  /^(?:react|react-dom|solid-js|@json-render\/(?:react|solid))(?:\/|$)|^@kit\/(?:react|solid)$|^@b\/shell\/api\/(?:react|solid)$/;
/** R12: specs are data — any key that is not the json-render grammar is a smuggled expression. */
const SPEC_KEYS = new Set([
  "root",
  "elements",
  "type",
  "props",
  "children",
  "visible",
  "repeat",
  "on",
  "statePath",
  "key",
  "action",
  "params",
]);
const specFiles = () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith(".json")
          ? [join(dir, e.name)]
          : [],
    );
  return walk(join(ROOT, "src/bundles"));
};
/** Every `$…` expression used by a spec. */
function expressionsOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) expressionsOf(v, out);
  else if (value !== null && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("$")) out.add(k);
      expressionsOf(v, out);
    }
  return out;
}

describe("boundary suite", () => {
  it("finds the tree it polices", () => {
    expect(logicFiles.length).toBeGreaterThan(15);
    expect(apiFiles.length).toBe(7);
    // The model bindings of Todos and Contacts (hello's is inline in its index.ts).
    expect(rendererFiles.map((s) => s.file).sort()).toEqual([
      "src/bundles/contacts.ui.jr/bindings.ts",
      "src/bundles/todos.ui.jr/bindings.ts",
    ]);
    expect(specFiles().length).toBe(7);
  });

  it("R1 model bindings value-import only the jr kit and their own files", () => {
    for (const s of rendererFiles) expect(rendererViolations(s), s.file).toEqual([]);
  });

  it("R2 views never provide, register, call, listen or await", () => {
    for (const s of rendererFiles) expect(s.code.match(RENDERER_RUNTIME) ?? [], s.file).toEqual([]);
  });

  it("R3 logic bundles and neutral API modules import no UI library", () => {
    const neutral = apiFiles.filter((s) => !/\/api\/(react|solid|jr)\//.test(s.file));
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

  it("R9 each technology's UI imports no other technology", () => {
    const uiFiles = all.filter((s) => techOfFile(s.file) !== undefined);
    expect(new Set(uiFiles.map((s) => techOfFile(s.file)))).toEqual(new Set(TECHS));
    for (const s of uiFiles)
      for (const i of s.imports)
        expect(foreignTech(s.file, i.spec), `${s.file} imports ${i.spec}`).toBe(false);
  });

  it("R10 a jr.<tech> bundle touches renderer extension points only: no logic API, no command, no panel", () => {
    const jr = all.filter((s) => /^src\/bundles\/jr\./.test(s.file));
    expect(new Set(jr.map((s) => bundleName(s.file)))).toEqual(new Set(["jr.react", "jr.solid"]));
    for (const s of jr) {
      for (const i of s.imports.filter((x) => x.spec.startsWith("@b/")))
        expect(i.spec, s.file).toMatch(JR_BUNDLE_OK);
      expect(s.code, s.file).not.toMatch(/\.\s*(?:provide|call|listen)\s*\(/);
    }
  });

  it("R11 views name no technology: specs and bindings are shared by React and Solid", () => {
    for (const s of viewBundleFiles)
      for (const i of s.imports)
        expect(TECHNOLOGY.test(i.spec), `${s.file} imports ${i.spec}`).toBe(false);
  });

  it("R12 specs are data: only the grammar's keys and the expressions this app allows", () => {
    const used = new Set<string>();
    for (const file of specFiles()) {
      const spec = JSON.parse(readFileSync(file, "utf8")) as { elements: Record<string, object> };
      for (const el of Object.values(spec.elements))
        for (const k of Object.keys(el)) expect(SPEC_KEYS.has(k), `${file}: ${k}`).toBe(true);
      expressionsOf(spec, used);
    }
    // Reported, and pinned: a new expression kind in a spec is a design decision, not a detail.
    console.info(`[specs] expressions used: ${[...used].sort().join(", ")}`);
    expect([...used].sort()).toEqual([
      "$bindState",
      "$computed",
      "$cond",
      "$else",
      "$item",
      "$state",
      "$template",
      "$then",
    ]);
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
          'import type { TodoListView } from "@b/todos/api";\nimport { constant } from "@kit/jr";',
        ),
      };
      expect(rendererViolations(good)).toEqual([]);
    });
    it("R2", () => {
      expect("slots.provide(x, y)".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("commands . call(todosAdd, {})".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("await x".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("m.save.submit()".match(RENDERER_RUNTIME)).toBeNull();
    });
    it("R3", () => {
      for (const bad of [
        "react",
        "react-dom/client",
        "@kit/react",
        "@kit/jr",
        "@b/shell/api/jr",
        "@b/todos.ui.jr",
        "@b/shell.react",
        "@b/jr.solid",
        "solid-js/web",
        "@json-render/react",
        "@kit/solid",
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
      expect(moduleOf("src/bundles/shell/api/jr/index.ts")).toBe("api:shell/api/jr");
      expect(resolve("src/bundles/hello/index.ts", "./api/index.js").path).toBe(
        "src/bundles/hello/api/index.js",
      );
    });
    it("R9", () => {
      expect(foreignTech("src/bundles/jr.react/catalog.tsx", "@json-render/solid")).toBe(true);
      expect(foreignTech("src/bundles/shell.solid/host.tsx", "react")).toBe(true);
      expect(foreignTech("src/bundles/jr.solid/view.tsx", "@b/shell/api/react")).toBe(true);
      expect(foreignTech("src/bundles/jr.solid/view.tsx", "solid-js")).toBe(false);
      expect(foreignTech("src/bundles/todos.core/index.ts", "react")).toBe(false);
    });
    it("R10, R11, R12", () => {
      expect(JR_BUNDLE_OK.test("@b/todos/api")).toBe(false);
      expect(JR_BUNDLE_OK.test("@b/shell/api/jr")).toBe(true);
      expect(TECHNOLOGY.test("@json-render/solid")).toBe(true);
      expect(TECHNOLOGY.test("@kit/jr")).toBe(false);
      expect(SPEC_KEYS.has("watch")).toBe(false);
      expect([...expressionsOf({ a: [{ $state: "/x" }, { b: { $bindState: "/y" } }] })]).toEqual([
        "$state",
        "$bindState",
      ]);
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
