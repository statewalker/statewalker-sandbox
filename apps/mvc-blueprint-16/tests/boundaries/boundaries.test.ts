import { describe, expect, it } from "vitest";
import {
  crossBundle,
  edges,
  importsOf,
  isInterpreterBundle,
  isSpecBundle,
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
/** J3's renderers: the spec files of `*.ui.spec` bundles (not their contribution file `index.ts`). */
const specFiles = all.filter(
  (s) => isSpecBundle(bundleName(s.file) ?? "") && !s.file.endsWith("/index.ts"),
);
/** The interpreters: the neutral kit, the per-technology kits, the per-technology bundles. */
const interpreterFiles = all.filter(
  (s) =>
    /^src\/kits\/spec(?:-dom|-solid)?\//.test(s.file) ||
    isInterpreterBundle(bundleName(s.file) ?? ""),
);
/** Everything J3 added to the UI layer: API, kits, interpreters, spec bundles. */
const j3Files = all.filter(
  (s) =>
    interpreterFiles.includes(s) ||
    isSpecBundle(bundleName(s.file) ?? "") ||
    s.file.startsWith("src/bundles/shell/api/spec/"),
);

// ── the rules, as predicates (each has a negative control below) ─────────────────────────────
/** R1: a spec file imports types only — it is data. */
const valueImports = (s: Source) => s.imports.filter((i) => !i.typeOnly).map((i) => i.spec);
/** R1b: a spec file holds no code: no call, arrow, function, class or template interpolation. */
const CODE = /=>|\bfunction\b|\bclass\s+[A-Za-z_$]|\$\{|\(/;
const specBody = (s: Source) => s.code.replace(/(?:^|\n)\s*import\s+type\s[^;]*;/g, "");

/** R2: an interpreter never publishes, fires, listens or awaits (the bundle's `register` is the mirror). */
const RENDERER_RUNTIME = /\.\s*(?:provide|call|listen)\s*\(|\bawait\b/g;

/** R3: a logic bundle or a neutral API module imports no UI library or UI module. */
const UI_SPEC =
  /^(?:react|react-dom|solid-js)(?:\/|$)|^@kit\/(?:dom|solid|spec|spec-dom|spec-solid)$|^@b\/shell\/api\/(?:dom|solid|spec)$|\.ui\.|^@b\/ui\.|^@b\/shell\.(?:dom|solid|test)/;

/** R9: a technology's UI (kits, renderer API, host, interpreter) imports no other technology. */
const TECHS = ["dom", "solid"] as const;
const TECH_OF: Record<(typeof TECHS)[number], RegExp> = {
  dom: /^@kit\/(?:dom|spec-dom)$|^@b\/shell\/api\/dom$|^@b\/shell\.(?:dom|test)|^@b\/ui\.dom\./,
  solid:
    /^solid-js(?:\/|$)|^@kit\/(?:solid|spec-solid)$|^@b\/shell\/api\/solid$|^@b\/shell\.solid|^@b\/ui\.solid\./,
};
const techOfFile = (file: string) =>
  TECHS.find((t) =>
    new RegExp(
      `^src/(?:kits/(?:${t}|spec-${t})/|bundles/shell/api/${t}/|bundles/shell\\.${t}/|bundles/ui\\.${t}\\.spec/)`,
    ).test(file),
  ) ?? (/^src\/bundles\/shell\.test\//.test(file) ? "dom" : undefined);
const foreignTech = (file: string, spec: string) => {
  const own = techOfFile(file);
  return own !== undefined && TECHS.some((t) => t !== own && TECH_OF[t].test(spec));
};
/** R11: the shared half (spec API, neutral kit, specs) imports no technology at all. */
const anyTech = (spec: string) => TECHS.some((t) => TECH_OF[t].test(spec));
const isShared = (file: string) =>
  /^src\/kits\/spec\/|^src\/bundles\/shell\/api\/spec\/|^src\/bundles\/[^/]+\.ui\.spec\//.test(
    file,
  );

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

/**
 * R12: no generic setter. The grammar has no path write (checked by `tests/spec`); here, the code:
 * the UI layer calls model members in exactly two places, both in the neutral kit — a group's
 * getter (`readGroup`) and a named intent (`dispatch`) — never assigns into a model, and has no
 * path-addressed store API.
 */
const MODEL_CALL = /\bmodel\s*\[[^\]]+\]\s*\(|\bmodel\s*\.\s*\w+\s*\(/g;
const MODEL_ASSIGN =
  /\bmodel\s*(?:\.\s*\w+|\[[^\]]+\])\s*=[^=]|Object\.assign\s*\(\s*model|Reflect\.set\s*\(/;
const PATH_STORE = /\b(?:setState|setByPath|setIn|updateIn|setPath)\b|\.set\s*\(\s*["'`/]/;

describe("boundary suite", () => {
  it("finds the tree it polices", () => {
    expect(logicFiles.length).toBeGreaterThan(15);
    // P0's 7 − React's renderer API + Solid's (U1) + the spec API (J3).
    expect(apiFiles.length).toBe(7);
    // One spec module per app: todos, contacts, hello.
    expect(specFiles.map((s) => s.file).sort()).toEqual([
      "src/bundles/contacts.ui.spec/specs.ts",
      "src/bundles/hello.ui.spec/spec.ts",
      "src/bundles/todos.ui.spec/specs.ts",
    ]);
    // Neutral kit (1), DOM kit (1), Solid kit (2), two interpreter bundles.
    expect(interpreterFiles.length).toBe(6);
    // No hand-written renderer is left: every `*.ui.*` bundle is a spec bundle.
    const uiBundles = new Set(
      all.map((s) => bundleName(s.file)).filter((b) => /\.ui\./.test(b ?? "")),
    );
    expect([...uiBundles].every((b) => isSpecBundle(b as string))).toBe(true);
  });

  it("R1 spec files import types only, and hold no code", () => {
    for (const s of specFiles) {
      expect(valueImports(s), s.file).toEqual([]);
      expect(specBody(s), s.file).not.toMatch(CODE);
    }
  });

  it("R2 interpreters never provide, call, listen or await", () => {
    for (const s of interpreterFiles)
      expect(s.code.match(RENDERER_RUNTIME) ?? [], s.file).toEqual([]);
  });

  it("R3 logic bundles and neutral API modules import no UI library", () => {
    const neutral = apiFiles.filter((s) => !/\/api\/(dom|solid|spec)\//.test(s.file));
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

  it("R11 the shared half (spec API, neutral kit, specs) imports no technology and no DOM", () => {
    const shared = all.filter((s) => isShared(s.file));
    expect(shared.length).toBe(8);
    for (const s of shared) {
      for (const i of s.imports) expect(anyTech(i.spec), `${s.file} imports ${i.spec}`).toBe(false);
      expect(s.code, s.file).not.toMatch(DOM_GLOBAL);
    }
  });

  it("R12 no generic setter: model members are called in two places only, never assigned", () => {
    const calls = j3Files.flatMap((s) =>
      (s.code.match(MODEL_CALL) ?? []).map((m) => `${s.file}: ${m.replace(/\s+/g, "")}`),
    );
    expect(calls.sort()).toEqual([
      "src/kits/spec/index.ts: model[getterOf(group)](",
      "src/kits/spec/index.ts: model[h.intent](",
    ]);
    for (const s of j3Files) {
      expect(s.code, s.file).not.toMatch(MODEL_ASSIGN);
      expect(s.code, s.file).not.toMatch(PATH_STORE);
    }
  });

  describe("negative controls: every rule can fail", () => {
    it("R1", () => {
      const bad = {
        file: "x",
        code: "",
        imports: importsOf('import { todosAdd } from "@b/todos/api";'),
      };
      expect(valueImports(bad)).toEqual(["@b/todos/api"]);
      for (const code of [
        "onClick: () => x",
        "label: `$" + "{n}`",
        "f(x)",
        "function f() {}",
        "class A {}",
      ])
        expect(code).toMatch(CODE);
      expect('{ el: "li", attrs: { class: "aria-[current=true]:bg-slate-100" } }').not.toMatch(
        CODE,
      );
      // The rule is not vacuous: the spec files are seen, with their type imports stripped.
      const list = specFiles.find((f) => f.file.endsWith("todos.ui.spec/specs.ts"));
      expect(list?.imports.map((i) => [i.spec, i.typeOnly])).toEqual([
        ["@b/shell/api/spec", true],
        ["@b/todos/api", true],
      ]);
      expect(specBody(list as Source)).not.toMatch(/import/);
    });
    it("R2", () => {
      expect("slots.provide(x, y)".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("commands . call(todosAdd, {})".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("await x".match(RENDERER_RUNTIME)).toHaveLength(1);
      expect("model.save.submit()".match(RENDERER_RUNTIME)).toBeNull();
    });
    it("R3", () => {
      for (const bad of [
        "solid-js/web",
        "@kit/dom",
        "@kit/spec",
        "@kit/spec-solid",
        "@b/shell/api/spec",
        "@b/todos.ui.spec",
        "@b/ui.dom.spec",
        "@b/shell.solid",
      ]) {
        expect(UI_SPEC.test(bad), bad).toBe(true);
      }
      for (const good of ["@kernel", "@kit/model", "@b/shell/api", "@b/todos/api", "solidity"]) {
        expect(UI_SPEC.test(good), good).toBe(false);
      }
    });
    it("R4", () => {
      expect("document.body").toMatch(DOM_GLOBAL);
      expect("documented").not.toMatch(DOM_GLOBAL);
    });
    it("R5", () => {
      const fake: Source[] = [
        {
          file: "src/bundles/ui.dom.spec/index.ts",
          code: "",
          imports: importsOf(
            'import { x } from "@b/todos.ui.spec";\nimport { y } from "@b/shell/api/spec";',
          ),
        },
      ];
      expect(crossBundle(edges(fake)).map((f) => [f.edge.spec, f.ok])).toEqual([
        ["@b/todos.ui.spec", false],
        ["@b/shell/api/spec", true],
      ]);
      expect(ownerOf(moduleOf("src/bundles/shell/api/spec/index.ts"))).toBe("bundle:shell");
      expect(resolve("src/bundles/hello/index.ts", "./api/index.js").path).toBe(
        "src/bundles/hello/api/index.js",
      );
    });
    it("R9, R11", () => {
      expect(foreignTech("src/kits/spec-dom/index.ts", "solid-js")).toBe(true);
      expect(foreignTech("src/bundles/ui.solid.spec/index.ts", "@kit/spec-dom")).toBe(true);
      expect(foreignTech("src/bundles/shell.test/dom/index.ts", "@kit/solid")).toBe(true);
      expect(foreignTech("src/kits/spec-solid/interpreter.tsx", "@kit/spec")).toBe(false);
      expect(isShared("src/kits/spec/index.ts") && anyTech("@kit/dom")).toBe(true);
      expect(anyTech("@kit/spec")).toBe(false);
    });
    it("R6, R7, R8", () => {
      expect(KERNEL_FORBIDDEN.test("@b/shell/api")).toBe(true);
      expect(ALIEN.test("alien-signals")).toBe(true);
      expect(mayImportSignals("src/bundles/todos.list/index.ts")).toBe(false);
      expect("export function f() {}").toMatch(IMPLEMENTATION);
      expect(API_VALUE_OK.test("zod")).toBe(false);
    });
    it("R12", () => {
      expect("model.setTitle(x)".match(MODEL_CALL)).toHaveLength(1);
      expect("model[path](v)".match(MODEL_CALL)).toHaveLength(1);
      expect("model.draft.title.length".match(MODEL_CALL)).toBeNull();
      expect('model["draft"] = v').toMatch(MODEL_ASSIGN);
      expect("model.draft = v").toMatch(MODEL_ASSIGN);
      expect("Object.assign(model, patch)").toMatch(MODEL_ASSIGN);
      expect("model.x === y").not.toMatch(MODEL_ASSIGN);
      expect('store.set("/draft/title", v)').toMatch(PATH_STORE);
      expect("setState(path, v)").toMatch(PATH_STORE);
      expect("cache.set(group, value)").not.toMatch(PATH_STORE);
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
