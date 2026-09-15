import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B0 · spec §2's "who may do what", checked against the files. A grep reads
 * spelling, not meaning: each rule's negative control proves it can fail, and
 * what walks past a pattern is written next to it.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
/** Drops block and line comments while leaving string and template literals — including a
 * `"http://…"` URL — untouched: literals are matched alongside comments and, unlike comments,
 * played back verbatim. */
const stripComments = (text: string) =>
  text.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/.*/g,
    (match) => (match.startsWith("/*") || match.startsWith("//") ? "" : match),
  );

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

interface Source {
  readonly file: string;
  readonly code: string;
}

const sources = (dir: string): Source[] =>
  walk(join(ROOT, dir)).map((path) => ({
    file: relative(ROOT, path),
    code: stripComments(readFileSync(path, "utf8")),
  }));

/** Every module specifier: `from "x"`, `import "x"`, `import("x")`. */
const specifiers = (code: string): string[] =>
  [...code.matchAll(/\b(?:from|import)\s*\(?\s*["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1]);

const FEATURES = ["todo", "stats", "progress", "logs"] as const;

/** UI modules: every feature's `ui/` directory and both hosts. */
const isUi = (file: string) => /^src\/lib\/(?:[^/]+\/ui|ui-react|ui-dom)\//.test(file);

/** DOM UI: the DOM host, and every `.ts` under a feature's `ui/` except its React entries. */
const isDomUi = (file: string) =>
  file.startsWith("src/lib/ui-dom/") ||
  (/^src\/lib\/[^/]+\/ui\//.test(file) && file.endsWith(".ts") && !/\/(?:index|react)\.ts$/.test(file));

/** What a UI module may never import. `@sys` exactly (it must take `@sys/ui`); relative paths into an `app/`, a `core/` or `sys/`. */
const UI_FORBIDDEN =
  /^(?:@statewalker\/shared-(?:commands|adapters|logger|baseclass|registry|slots)|@signals|alien-signals|@sys|@(?:todo|stats|progress|logs)\/(?:app|core))$|^\.\.?\/.*\b(?:app|core|sys)\//;

/** Calls a UI module may never make. Walked past by `slots["provide"](…)`. */
const UI_PUBLISHES = /\.\s*(?:provide|register)\s*\(/;

/** React, by any spelling a DOM module could use. */
const REACT_SPEC = /^(?:react|react-dom)(?:\/|$)|^@statewalker\/ui\.view\.shadcn|^@ui\/react$/;

/** A module-scope logger resolution — it would capture the default before LogsController replaces it. */
const MODULE_SCOPE_LOGGER =
  /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*getLogger\(|^getLogger\(/m;

const featureOf = (file: string) => /^src\/lib\/([^/]+)\//.exec(file)?.[1];

/** A relative specifier as a path from the app root (`src/lib/stats/app/x.js`); undefined for a bare one. */
const resolveRelative = (file: string, spec: string) =>
  /^\.\.?\//.test(spec) ? normalize(join(dirname(file), spec)) : undefined;

describe("B0 · boundaries", () => {
  // `lib/` now lives under `src/lib/`; walking `src` alone covers it, so this must not
    // also walk `lib` — that would double-count every file under `src/lib`.
  const all = () => sources("src");

  it("finds the tree it polices — nested files included", () => {
    const files = sources("src/lib").map((s) => s.file);
    expect(files).toEqual(
      expect.arrayContaining([
        "src/lib/ui-dom/host.ts",
        "src/lib/ui-react/host.tsx",
        "src/lib/stats/ui/stats-view.ts",
        "src/lib/todo/app/todo-controller.ts",
      ]),
    );
  });

  it("every test lives under tests/ — none beside the code in src/lib/ or src/", () => {
    const misplaced = all()
      .map((s) => s.file)
      .filter(
        (file) =>
          /\.test\.tsx?$/.test(file) || /(?:^|\/)(?:tests?|__tests__|test-support)\//.test(file),
      );
    expect(misplaced).toEqual([]);
    expect(
      sources("tests").some((s) => s.file === "tests/B0-boundaries/boundaries.test.ts"),
      "the walker sees tests/",
    ).toBe(true);
  });

  describe("the UI sees only view models and ui:* slots", () => {
    it("UI modules import no bus, no context, no logger, no reactive library, no feature implementation", () => {
      const ui = sources("src/lib").filter((s) => isUi(s.file));
      expect(ui.length).toBeGreaterThan(5);
      for (const { file, code } of ui) {
        for (const spec of specifiers(code)) {
          expect(UI_FORBIDDEN.test(spec), `${file} imports "${spec}"`).toBe(false);
        }
      }
    });

    it("UI modules never provide or register a contribution", () => {
      const ui = sources("src/lib").filter((s) => isUi(s.file));
      expect(ui.length).toBeGreaterThan(5);
      for (const { file, code } of ui) {
        expect(code, `${file} publishes to a slot`).not.toMatch(UI_PUBLISHES);
      }
    });

    it("DOM UI modules load no React", () => {
      const dom = sources("src/lib").filter((s) => isDomUi(s.file));
      expect(dom.map((s) => s.file)).toEqual(
        expect.arrayContaining(["src/lib/ui-dom/host.ts", "src/lib/stats/ui/stats-view.ts"]),
      );
      for (const { file, code } of dom) {
        for (const spec of specifiers(code))
          expect(REACT_SPEC.test(spec), `${file} imports "${spec}"`).toBe(false);
      }
    });

    it("a feature's models.ts carries interfaces and kinds only: its one value import is @sys/ui", () => {
      const models = sources("src/lib").filter((s) => /^src\/lib\/[^/]+\/app\/models\.ts$/.test(s.file));
      expect(models.length).toBe(3);
      for (const { file, code } of models) {
        const valueImports = [
          ...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm),
        ].map((m) => m[1]);
        for (const spec of valueImports)
          expect(spec, `${file} value-imports "${spec}"`).toBe("@sys/ui");
      }
    });
  });

  describe("features meet only through services, slots, commands and models", () => {
    it("no feature's app layer imports another feature's app, models or ui — cores are shared declarations", () => {
      const appFiles = sources("src/lib").filter((s) => /^src\/lib\/[^/]+\/app\//.test(s.file));
      expect(appFiles.length).toBeGreaterThan(10);
      for (const { file, code } of appFiles) {
        const own = featureOf(file);
        for (const spec of specifiers(code)) {
          const m = /^@([^/]+)\/(app|models|ui)(?:\/|$)/.exec(spec);
          if (m && (FEATURES as readonly string[]).includes(m[1])) {
            expect(m[1], `${file} imports "${spec}"`).toBe(own);
          }
          expect(/^@ui\/(?:react|dom)$/.test(spec), `${file} imports a host: "${spec}"`).toBe(
            false,
          );
          const target = resolveRelative(file, spec);
          if (target?.startsWith("src/lib/")) {
            expect(featureOf(target), `${file} reaches into "${target}" by a relative path`).toBe(
              own,
            );
          }
        }
      }
    });

    it("src/lib/sys imports no feature and no host", () => {
      const sys = sources("src/lib/sys");
      expect(sys.length).toBeGreaterThan(3);
      for (const { file, code } of sys) {
        for (const spec of specifiers(code)) {
          expect(
            /^@(?:todo|stats|progress|logs|ui)\//.test(spec) || /^\.\.\//.test(spec),
            `${file} imports "${spec}"`,
          ).toBe(false);
        }
      }
    });

    it("only src/app.ts wires a host to a controller", () => {
      const roots = all()
        .filter(({ code }) => {
          const specs = specifiers(code);
          return (
            specs.some((s) => /^@ui\/(?:react|dom)$/.test(s)) &&
            specs.some((s) => /^@(?:todo|stats|progress|logs)\/app$/.test(s))
          );
        })
        .map((s) => s.file);
      expect(roots).toEqual(["src/app.ts"]);
    });
  });

  describe("each substrate stays in its box", () => {
    const importers = (pattern: RegExp) =>
      all()
        .filter(({ code }) => specifiers(code).some((s) => pattern.test(s)))
        .map((s) => s.file)
        .sort();

    it("alien-signals is imported only by src/lib/signals/alien.ts", () => {
      expect(importers(/^alien-signals$/)).toEqual(["src/lib/signals/alien.ts"]);
    });

    it("@signals is imported only inside the todo feature's app layer", () => {
      const files = importers(/^@signals$/);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(file.startsWith("src/lib/todo/app/"), file).toBe(true);
    });

    it("shared-baseclass is imported only inside the stats feature's app layer", () => {
      const files = importers(/^@statewalker\/shared-baseclass$/);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(file.startsWith("src/lib/stats/app/"), file).toBe(true);
    });

    it("no module resolves the logger at module scope", () => {
      for (const { file, code } of all()) expect(code, file).not.toMatch(MODULE_SCOPE_LOGGER);
    });
  });

  describe("the rules can fail — negative controls", () => {
    it("stripComments keeps string literals — including a URL's // — but drops real comments", () => {
      expect(
        specifiers(stripComments('const u = "http://x"; import { getSlots } from "@sys";')),
      ).toEqual(["@sys"]);
      expect(specifiers(stripComments('// import { getSlots } from "@sys";'))).toEqual([]);
      expect(specifiers(stripComments('/* import { getSlots } from "@sys"; */'))).toEqual([]);
    });

    it("UI_FORBIDDEN rejects what it exists for, and allows what a UI needs", () => {
      for (const bad of [
        "@statewalker/shared-commands",
        "@statewalker/shared-adapters",
        "@statewalker/shared-logger",
        "@signals",
        "alien-signals",
        "@sys",
        "@todo/app",
        "@stats/core",
        "../app/todo-controller.js",
      ]) {
        expect(UI_FORBIDDEN.test(bad), bad).toBe(true);
      }
      for (const bad of [
        "@statewalker/shared-slots",
        "../../sys/index.js",
        "../core/declarations.js",
      ]) {
        expect(UI_FORBIDDEN.test(bad), bad).toBe(true);
      }
      for (const good of [
        "@sys/ui",
        "@todo/models",
        "@ui/react",
        "react",
        "@statewalker/ui.view.shadcn",
        "./checkbox.js",
      ]) {
        expect(UI_FORBIDDEN.test(good), good).toBe(false);
      }
    });

    it("UI_PUBLISHES, REACT_SPEC and MODULE_SCOPE_LOGGER match their violations", () => {
      expect("slots.provide(dialogsSlot, x)").toMatch(UI_PUBLISHES);
      expect("slots . register(panelsSlot, 'p', x)").toMatch(UI_PUBLISHES);
      expect("model.requestToggle(id)").not.toMatch(UI_PUBLISHES);
      for (const bad of ["react", "react-dom/client", "@statewalker/ui.view.shadcn", "@ui/react"])
        expect(REACT_SPEC.test(bad), bad).toBe(true);
      expect(REACT_SPEC.test("@ui/dom")).toBe(false);
      expect("const log = getLogger(ctx);\n").toMatch(MODULE_SCOPE_LOGGER);
      expect("  this._log = getLogger(ctx).child({});\n").not.toMatch(MODULE_SCOPE_LOGGER);
    });

    it("resolveRelative places a relative specifier in its feature", () => {
      expect(
        featureOf(
          resolveRelative("src/lib/todo/app/todo-controller.ts", "../../stats/app/stats-model.js") ??
            "",
        ),
      ).toBe("stats");
      expect(
        featureOf(resolveRelative("src/lib/todo/app/todo-controller.ts", "./models.js") ?? ""),
      ).toBe("todo");
      expect(resolveRelative("src/lib/todo/app/todo-controller.ts", "@stats/app")).toBeUndefined();
    });

    it("isUi and isDomUi classify by location", () => {
      expect(isUi("src/lib/todo/ui/list-view.tsx")).toBe(true);
      expect(isUi("src/lib/todo/app/models.ts")).toBe(false);
      expect(isDomUi("src/lib/stats/ui/stats-view.ts")).toBe(true);
      expect(isDomUi("src/lib/stats/ui/react.ts")).toBe(false);
      expect(isDomUi("src/lib/todo/ui/index.ts")).toBe(false);
    });
  });
});
