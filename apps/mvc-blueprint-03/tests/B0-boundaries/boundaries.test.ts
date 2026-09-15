import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B0 · the spec's "who may do what", checked against the files. A grep reads
 * spelling, not meaning: every rule has a negative control, and what walks past
 * a pattern is written next to it.
 */
const ROOT = new URL("../../", import.meta.url).pathname;

/** Drops comments; keeps string and template literals, so `"http://…"` is not mistaken for a comment. */
const stripComments = (text: string) =>
  text.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_match, literal: string | undefined) => literal ?? "",
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

/** Every module specifier: `from "x"`, `import "x"`, `import("x")`. Multi-line imports included. */
const specifiers = (code: string): string[] =>
  [...code.matchAll(/\b(?:from|import)\s*\(?\s*["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1]);

/** Value imports only (not `import type …`). */
const valueImports = (code: string): string[] =>
  [...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);

/** A relative specifier as a path from the app root; undefined for a bare one. */
const resolveRelative = (file: string, spec: string) =>
  /^\.\.?\//.test(spec) ? normalize(join(dirname(file), spec)) : undefined;

/** What a UI module may import, besides relative paths inside src/ui. */
const UI_ALLOWED =
  /^(?:react(?:\/.*)?|react-dom\/client|@statewalker\/ui\.view\.shadcn|@statewalker\/shared-registry|@sys\/extension-points|@sys\/action\/model|@todos\/(?:list|edit|clear-completed)\/model|@notifications\/model|@ui\/.+)$/;

/** Calls a UI module may never make. Walked past by `slots["provide"](…)`. */
const UI_PUBLISHES = /\.\s*(?:provide|register)\s*\(/;

/** A domain's index alias: controller and implementation included. Only the composition root may import one. */
const DOMAIN_INDEX = /^(?:@todos\/(?:list|edit|clear-completed)|@notifications)$/;

const DOMAINS = [
  "src/lib/todos/core",
  "src/lib/todos/list",
  "src/lib/todos/edit",
  "src/lib/todos/clear-completed",
  "src/lib/notifications",
] as const;
const domainOf = (file: string) => DOMAINS.find((d) => file.startsWith(`${d}/`));

/** What a *.model.impl.ts may import, besides its own *.model.js. Type imports included. */
const IMPL_ALLOWED =
  /^(?:@statewalker\/shared-registry|@sys\/signals|@sys\/model-kit|@sys\/action)$/;

/** A model implementation's imports: the allowed modules, or exactly `./<name>.model.js` beside it. */
const implMayImport = (file: string, spec: string) =>
  IMPL_ALLOWED.test(spec) ||
  spec === `./${basename(file).replace(/\.model\.impl\.ts$/, ".model.js")}`;

/** The signals library, subpaths included (an alias or package export matches as a prefix). */
const ALIEN_SIGNALS = /^alien-signals(?:\/|$)/;

/** The kernel's signals alias, subpaths included. */
const SYS_SIGNALS = /^@sys\/signals(?:\/|$)/;

/** Who may import `@sys/signals`: the kernel and model implementations. */
const mayImportSignals = (file: string) =>
  file.startsWith("src/lib/sys/") || file.endsWith(".model.impl.ts");

/** A call to the todo api's setter. Walked past by an alias: `const s = setTodoApi; s(ctx, api)`. */
const SETS_TODO_API = /\bsetTodoApi\s*\(/;

/** A domain or UI alias — what src/lib/sys may never import. */
const SYS_FORBIDDEN = /^@(?:todos|notifications|ui)(?:\/|$)/;

/** A test file or a test folder beside the code. Walked past by `*.spec.ts` or a `fixtures/` folder. */
const isTestLocation = (file: string) =>
  /\.test\.tsx?$/.test(file) || /(?:^|\/)(?:tests?|__tests__)\//.test(file);

/** A module-scope logger resolution. */
const MODULE_SCOPE_LOGGER =
  /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*getLogger\(|^getLogger\(/m;

describe("B0 · boundaries", () => {
  const all = () => sources("src");
  const ui = () => sources("src/ui");
  const lib = () => sources("src/lib");

  it("finds the tree it polices", () => {
    const files = all().map((s) => s.file);
    expect(files).toEqual(
      expect.arrayContaining([
        "src/app.ts",
        "src/lib/sys/action/action.model.impl.ts",
        "src/lib/todos/list/list.controller.ts",
        "src/ui/host/host.tsx",
        "src/ui/todos/list/list-view.tsx",
      ]),
    );
  });

  describe("the UI sees only model interfaces and extension points", () => {
    it("UI modules import only React, the kit, the registry, extension points, model interfaces and other UI modules", () => {
      const files = ui();
      expect(files.length).toBeGreaterThan(10);
      for (const { file, code } of files) {
        for (const spec of specifiers(code)) {
          const target = resolveRelative(file, spec);
          if (target !== undefined) {
            expect(target.startsWith("src/ui/"), `${file} reaches "${target}"`).toBe(true);
          } else {
            expect(UI_ALLOWED.test(spec), `${file} imports "${spec}"`).toBe(true);
          }
        }
      }
    });

    it("UI modules never provide or register a contribution", () => {
      const files = ui();
      expect(files.length).toBeGreaterThan(10);
      for (const { file, code } of files) expect(code, file).not.toMatch(UI_PUBLISHES);
    });
  });

  describe("domains meet only through commands, extension points and model interfaces", () => {
    it("no module under src/lib imports a domain's index alias", () => {
      const files = lib();
      expect(files.length).toBeGreaterThan(20);
      for (const { file, code } of files) {
        for (const spec of specifiers(code))
          expect(DOMAIN_INDEX.test(spec), `${file} imports "${spec}"`).toBe(false);
      }
    });

    it("a domain's relative imports stay inside its own folder", () => {
      const files = lib().filter((s) => domainOf(s.file) !== undefined);
      expect(files.length).toBeGreaterThan(15);
      for (const { file, code } of files) {
        const own = domainOf(file) as string;
        for (const spec of specifiers(code)) {
          const target = resolveRelative(file, spec);
          if (target !== undefined)
            expect(target.startsWith(`${own}/`), `${file} reaches "${target}"`).toBe(true);
        }
      }
    });

    it("a *.model.ts has one value import at most: @sys/extension-points", () => {
      const models = lib().filter((s) => s.file.endsWith(".model.ts"));
      expect(models.length).toBe(5);
      for (const { file, code } of models) {
        for (const spec of valueImports(code))
          expect(spec, `${file} value-imports "${spec}"`).toBe("@sys/extension-points");
      }
    });

    it("a *.model.impl.ts imports only the registry, the kernel's signals, model kit and action, and its own model", () => {
      const impls = lib().filter((s) => s.file.endsWith(".model.impl.ts"));
      expect(impls.length).toBe(5);
      for (const { file, code } of impls) {
        for (const spec of specifiers(code))
          expect(implMayImport(file, spec), `${file} imports "${spec}"`).toBe(true);
      }
    });

    it("src/lib/sys imports no domain and no UI", () => {
      const files = sources("src/lib/sys");
      expect(files.length).toBeGreaterThan(8);
      for (const { file, code } of files) {
        for (const spec of specifiers(code)) {
          expect(SYS_FORBIDDEN.test(spec), `${file} imports "${spec}"`).toBe(false);
          const target = resolveRelative(file, spec);
          if (target !== undefined)
            expect(target.startsWith("src/lib/sys/"), `${file} reaches "${target}"`).toBe(true);
        }
      }
    });
  });

  describe("the substrate and the services stay in their boxes", () => {
    const importers = (pattern: RegExp) =>
      all()
        .filter(({ code }) => specifiers(code).some((s) => pattern.test(s)))
        .map((s) => s.file)
        .sort();

    it("alien-signals is imported only by src/lib/sys/signals/alien.ts", () => {
      expect(importers(ALIEN_SIGNALS)).toEqual(["src/lib/sys/signals/alien.ts"]);
    });

    it("@sys/signals is imported only by the kernel and model implementations", () => {
      const files = importers(SYS_SIGNALS);
      expect(files.length).toBeGreaterThan(4);
      for (const file of files) expect(mayImportSignals(file), file).toBe(true);
    });

    it("only the composition root sets the todo api, and only it wires the UI host to controllers", () => {
      expect(
        all()
          .filter(({ code }) => SETS_TODO_API.test(code))
          .map((s) => s.file),
      ).toEqual(["src/app.ts"]);
      const roots = all()
        .filter(({ code }) => {
          const specs = specifiers(code);
          return specs.includes("@ui/host") && specs.some((s) => DOMAIN_INDEX.test(s));
        })
        .map((s) => s.file);
      expect(roots).toEqual(["src/app.ts"]);
    });

    it("no module resolves the logger at module scope", () => {
      for (const { file, code } of all()) expect(code, file).not.toMatch(MODULE_SCOPE_LOGGER);
    });

    it("every test lives under tests/ — none beside the code", () => {
      const misplaced = all()
        .map((s) => s.file)
        .filter(isTestLocation);
      expect(misplaced).toEqual([]);
      expect(
        sources("tests").some((s) => s.file === "tests/B0-boundaries/boundaries.test.ts"),
      ).toBe(true);
    });
  });

  describe("the rules can fail — negative controls", () => {
    it("UI_ALLOWED rejects services, buses, signals, implementations and domain indexes", () => {
      for (const bad of [
        "@statewalker/shared-commands",
        "@statewalker/shared-slots",
        "@statewalker/shared-adapters",
        "@statewalker/shared-logger",
        "alien-signals",
        "@sys/signals",
        "@sys/context",
        "@sys/action",
        "@sys/model-kit",
        "@todos/core",
        "@todos/list",
        "@todos/edit/commands",
        "@notifications",
      ]) {
        expect(UI_ALLOWED.test(bad), bad).toBe(false);
      }
      for (const good of [
        "react",
        "react-dom/client",
        "@sys/action/model",
        "@todos/list/model",
        "@ui/host",
      ]) {
        expect(UI_ALLOWED.test(good), good).toBe(true);
      }
    });

    it("the model-implementation rule rejects services, domains, extension points and another model", () => {
      const impl = "src/lib/todos/list/list.model.impl.ts";
      for (const good of [
        "@statewalker/shared-registry",
        "@sys/signals",
        "@sys/model-kit",
        "@sys/action",
        "./list.model.js",
      ]) {
        expect(implMayImport(impl, good), good).toBe(true);
      }
      for (const bad of [
        "alien-signals",
        "@statewalker/shared-commands",
        "@sys/extension-points",
        "@sys/context",
        "@sys/action/model",
        "@todos/core",
        "./list.controller.js",
        "./edit.model.js",
        "../edit/edit.model.js",
        "./list.model.impl.js",
      ]) {
        expect(implMayImport(impl, bad), bad).toBe(false);
      }
    });

    it("the signals rules match the library and the alias, subpaths included, and only them", () => {
      expect(
        specifiers('import * as A from "alien-signals";').some((s) => ALIEN_SIGNALS.test(s)),
      ).toBe(true);
      expect(ALIEN_SIGNALS.test("alien-signals/system")).toBe(true);
      expect(ALIEN_SIGNALS.test("@sys/signals")).toBe(false);
      expect(ALIEN_SIGNALS.test("alien-signals-extra")).toBe(false);
      expect(
        specifiers('import { signal } from "@sys/signals";').some((s) => SYS_SIGNALS.test(s)),
      ).toBe(true);
      expect(SYS_SIGNALS.test("@sys/signals/contract")).toBe(true);
      expect(SYS_SIGNALS.test("@sys/signalsx")).toBe(false);
      expect(SYS_SIGNALS.test("@sys/model-kit")).toBe(false);
      expect(mayImportSignals("src/lib/sys/model-kit.ts")).toBe(true);
      expect(mayImportSignals("src/lib/todos/edit/edit.model.impl.ts")).toBe(true);
      expect(mayImportSignals("src/lib/todos/edit/edit.controller.ts")).toBe(false);
      expect(mayImportSignals("src/lib/todos/edit/edit.model.ts")).toBe(false);
      expect(mayImportSignals("src/ui/host/use-model.ts")).toBe(false);
    });

    it("the setTodoApi, test-location and sys-imports rules match their violations and nothing else", () => {
      expect("setTodoApi(ctx, api);").toMatch(SETS_TODO_API);
      expect("  setTodoApi (context, new MemTodoApi())").toMatch(SETS_TODO_API);
      expect("getTodoApi(ctx);").not.toMatch(SETS_TODO_API);
      expect("resetTodoApi(ctx);").not.toMatch(SETS_TODO_API);
      expect('import { setTodoApi } from "@todos/core";').not.toMatch(SETS_TODO_API);

      for (const bad of [
        "src/lib/todos/list/list.test.ts",
        "src/ui/host/host.test.tsx",
        "src/lib/sys/__tests__/kit.ts",
        "src/lib/test/helpers.ts",
        "src/ui/tests/react.ts",
      ]) {
        expect(isTestLocation(bad), bad).toBe(true);
      }
      for (const good of [
        "src/lib/sys/attempt.ts",
        "src/lib/testing.ts",
        "src/lib/contest/entry.ts",
        "src/lib/todos/list/list.tests.ts",
      ]) {
        expect(isTestLocation(good), good).toBe(false);
      }

      for (const bad of [
        "@todos/core",
        "@todos/events",
        "@notifications",
        "@notifications/model",
        "@ui/host",
      ]) {
        expect(SYS_FORBIDDEN.test(bad), bad).toBe(true);
      }
      for (const good of ["@sys/signals", "@statewalker/shared-registry", "@todosx", "@uikit"]) {
        expect(SYS_FORBIDDEN.test(good), good).toBe(false);
      }
      expect(resolveRelative("src/lib/sys/action/index.ts", "../../todos/core/index.js")).toBe(
        "src/lib/todos/core/index.js",
      );
    });

    it("the helpers match their violations", () => {
      expect("slots . register(panelsSlot, 'p', x)").toMatch(UI_PUBLISHES);
      expect("model.actions.add.submit()").not.toMatch(UI_PUBLISHES);
      expect(DOMAIN_INDEX.test("@todos/edit")).toBe(true);
      expect(DOMAIN_INDEX.test("@todos/edit/model")).toBe(false);
      expect("const log = getLogger(ctx);\n").toMatch(MODULE_SCOPE_LOGGER);
      expect("  const log = getLogger(ctx).child({});\n").not.toMatch(MODULE_SCOPE_LOGGER);
      expect(
        resolveRelative("src/lib/todos/list/list.controller.ts", "../edit/edit.model.impl.js"),
      ).toBe("src/lib/todos/edit/edit.model.impl.js");
      expect(
        specifiers(stripComments('const u = "http://x"; import { a } from "@sys/context";')),
      ).toEqual(["@sys/context"]);
      expect(
        specifiers(stripComments('// import "@sys/context"\n/* import "@sys/signals" */')),
      ).toEqual([]);
      expect(
        valueImports(
          'import type { A } from "@todos/core";\nimport { b } from "@sys/extension-points";',
        ),
      ).toEqual(["@sys/extension-points"]);
    });
  });
});
