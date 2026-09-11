import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { BaseClass } from "@statewalker/shared-baseclass";
import * as modelEntry from "@todo/app/models";
import { describe, expect, it } from "vitest";

/**
 * B0 — the layering, checked as a fact about the files.
 *
 * `ui:show-job` was declared in fm-core from P0 until a grep caught it at P5,
 * four rungs later. A boundary you do not grep is not a boundary. Recursive,
 * because todo-ui has subdirectories and a non-recursive readdir skips them
 * silently — which would reintroduce exactly the failure this prevents.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const isSource = (f: string) => f.endsWith(".ts") || f.endsWith(".tsx");
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const sources = (pkg: string) =>
  readdirSync(`${ROOT}lib/${pkg}/src`, { recursive: true, encoding: "utf8" })
    .filter(isSource)
    .map((f) => ({
      file: `${pkg}/src/${f}`,
      code: stripComments(readFileSync(`${ROOT}lib/${pkg}/src/${f}`, "utf8")),
    }));

const QUOTE = "[\"'`]";
const NOT_QUOTE = "[^\"'`\\n]";

/**
 * An import of layer `pkg`, by alias OR by a relative path walking into its
 * directory. An alias-only grep is walked straight past by
 * `"../../todo-app/src/todo-model.js"`, which reaches the same file and names no
 * alias — so every import assertion below goes through this, never a bare
 * `/@todo\/x/`. The relative half requires a leading `./` or `../`, which is
 * what an import specifier looks like and a path in a message does not.
 */
const importOf = (pkg: string) =>
  new RegExp(`@todo/${pkg}\\b|${QUOTE}\\.\\.?/${NOT_QUOTE}*\\btodo-${pkg}/`);

/**
 * A write to a model field from outside the model (spec §4.8): plain, compound
 * or `??=` assignment, and `++`/`--` either side. The receiver is anything whose
 * name contains "model" — a controller's `_model`, a `model` parameter, a
 * `listModel` — followed by any member chain, so `this._model.todos = […]` is
 * caught as surely as `model.input.pending = []`. `=(?![=>])` keeps `==`, `===`
 * and `=>` out of it.
 */
const MODEL_CHAIN = String.raw`\b\w*[Mm]odel\w*(?:\.\w+)+`;
const ASSIGN = String.raw`(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?![=>])`;
const MODEL_FIELD_WRITE = new RegExp(
  `${MODEL_CHAIN}\\s*(?:${ASSIGN}|\\+\\+|--)|(?:\\+\\+|--)\\s*${MODEL_CHAIN}`,
);

/**
 * The files the model rules exempt, named by LOCATION, not by suffix. A bare
 * `endsWith("-model.ts")` also admitted `todo-ui/src/use-model.ts` and any
 * `todo-ui/src/views/selection-model.ts` someone might add — each free to
 * write fields, notify and subscribe to bare `onUpdate`. A model lives in
 * `todo-app`, so that is the only place the exemption reaches.
 */
const isModelModule = (file: string): boolean => file.startsWith("todo-app/src/") && file.endsWith("-model.ts");

/** The React binding: exempt from the bare-`onUpdate` rule and from nothing else. */
const REACT_BINDING = "todo-ui/src/use-model.ts";

/**
 * What a view may call on a model. Everything else a model class carries —
 * found at run time below, not listed — belongs to the controller (the outer
 * model's mutators, the input's `take*()` drains) or to the model itself
 * (`notify`, `fromJSON`). Default-deny: a method added to a model later is
 * off-limits to views until it is named here.
 */
const VIEW_MAY_CALL = new Set([
  // TodoListInput — one mutator per gesture (spec §4.8)
  "setFilter",
  "setShowDone",
  "requestRefresh",
  "queueSubmit",
  "requestToggle",
  "requestRemove",
  "requestClearCompleted",
  // TodoListModel — a derived read
  "visible",
  // BaseClass — a read
  "toJSON",
]);

/**
 * Every method on the prototype chain of every model class the view layer's
 * one entry (`@todo/app/models`) exports — inherited `BaseClass` methods
 * included, since `fromJSON` writes fields as surely as a mutator does.
 */
const modelMethods = (): Set<string> => {
  const names = new Set<string>();
  for (const value of Object.values(modelEntry)) {
    if (typeof value !== "function" || !(value.prototype instanceof BaseClass)) continue;
    for (let proto = value.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name !== "constructor" && typeof Object.getOwnPropertyDescriptor(proto, name)?.value === "function") {
          names.add(name);
        }
      }
    }
  }
  return names;
};

/** The methods a view may not name: every model method not in `VIEW_MAY_CALL`. */
const CONTROLLER_SIDE = [...modelMethods()].filter((name) => !VIEW_MAY_CALL.has(name)).sort();

/**
 * A reference to one of `names` as a member — `.name`, called or not, or
 * `["name"]`. Not a bare identifier: `notify` is also a word in
 * `"./views/notify-view.js"`.
 */
const memberOf = (names: string[]) =>
  new RegExp(`\\.\\s*(?:${names.join("|")})\\b|\\[\\s*${QUOTE}(?:${names.join("|")})${QUOTE}\\s*\\]`);
const CONTROLLER_CALL = memberOf(CONTROLLER_SIDE);

/** Every rung's suites, found by walking `<rung>/tests` recursively. */
const allSuites = () =>
  readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !["lib", "node_modules", "src"].includes(d.name))
    .flatMap((d) => {
      const dir = `${ROOT}${d.name}/tests`;
      let files: string[] = [];
      try {
        files = (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[]).filter(isSource);
      } catch {
        return [];
      }
      return files.map((f) => ({
        file: `${d.name}/tests/${f}`,
        code: stripComments(readFileSync(`${dir}/${f}`, "utf8")),
      }));
    });

const DOM_GLOBALS = /\b(document|window|HTMLElement|navigator)\b/;

/**
 * A `todo-ui` import of todo-app that is NOT the models-only entry — alias or
 * relative path. Module-scope so the negative control at the bottom can prove
 * it still rejects a controller import: a regex weakened later would
 * otherwise pass every real file and nobody would know.
 */
const BEYOND_MODELS = new RegExp(
  `@todo/app(?!/models${QUOTE})|${QUOTE}\\.\\.?/${NOT_QUOTE}*\\btodo-app/`,
);

/** Every module specifier in `code`: `from "x"`, `import "x"`, `import("x")`. */
const specifiers = (code: string): string[] =>
  [...code.matchAll(/\b(?:from|import)\s*\(?\s*["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1]);

/**
 * A specifier reaching the view layer somewhere OTHER than its adapter entry.
 * `@todo/ui` is the React entry — it re-exports the views, and with them
 * react-dom and the kit — so a headless module that takes it loads a DOM
 * library by accident, and dies at import the moment any view touches
 * `document` at module scope.
 */
const reachesUiBeyondAdapter = (spec: string): boolean => {
  if (/^@todo\/ui(\/|$)/.test(spec)) return spec !== "@todo/ui/adapter";
  if (/^\.\.?\//.test(spec) && /\btodo-ui\//.test(spec)) {
    return !/\btodo-ui\/src\/view-adapter(\.js|\.ts)?$/.test(spec);
  }
  return false;
};

/**
 * What `view-adapter.ts` may import: the bus and the registry, nothing else.
 * A whitelist, not a React blacklist — a relative `./use-model.js` pulls React
 * in just as surely as `"react"` does, and a blacklist would miss it.
 */
const ADAPTER_MAY_IMPORT = /^@statewalker\/shared-(commands|registry)$/;

/**
 * The modules a node suite can load: every `*.test.ts`, and the shared test
 * support. B0 itself is left out — it spells the bad specifiers as fixtures;
 * it is the grep, not an importer.
 */
const headlessModules = () => [
  ...allSuites().filter(({ file }) => file.endsWith(".test.ts") && !file.startsWith("B0-boundaries/")),
  ...(readdirSync(`${ROOT}test-support`, { recursive: true, encoding: "utf8" }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({
      file: `test-support/${f}`,
      code: stripComments(readFileSync(`${ROOT}test-support/${f}`, "utf8")),
    })),
];

/**
 * Does `code` take the view layer's REACT entry — `@todo/ui` or a view, by
 * alias or relative path — rather than only the headless `@todo/ui/adapter`?
 */
const usesReactEntry = (code: string): boolean => specifiers(code).some(reachesUiBeyondAdapter);

/**
 * Does `code` wire the core to the React views — import the core, the app and
 * the view layer's React entry? Only the composition root may: it is where the
 * core's api, the app's bootstrap and the ui's views meet, and a second module
 * that does that is a second composition root nobody reviews as one.
 *
 * The ui half is the React entry, not any `todo-ui` import: a headless suite
 * that boots `bootstrap` over a real `MemTodoApi` and a `ViewAdapter` from
 * `@todo/ui/adapter` is a protocol harness — it can render nothing — and
 * counting the adapter made such suites hand-roll a copy of the core instead.
 */
const knowsEveryLayer = (code: string): boolean =>
  importOf("core").test(code) && importOf("app").test(code) && usesReactEntry(code);

/** The page's own modules under `src/` — the entry and the composition root. */
const pageSources = () =>
  (readdirSync(`${ROOT}src`, { recursive: true, encoding: "utf8" }) as string[]).filter(isSource).map((f) => ({
    file: `src/${f}`,
    code: stripComments(readFileSync(`${ROOT}src/${f}`, "utf8")),
  }));

/**
 * Every module specifier reachable from a root-level config file, following
 * its relative imports (a `.js` specifier names the `.ts` beside it). A config
 * that takes one table from a sibling module is only as clean as that module.
 */
const reachableSpecifiers = (file: string, seen = new Set<string>()): string[] => {
  if (seen.has(file)) return [];
  seen.add(file);
  return specifiers(stripComments(readFileSync(`${ROOT}${file}`, "utf8"))).flatMap((spec) =>
    /^\.\.?\//.test(spec)
      ? [spec, ...reachableSpecifiers(normalize(join(dirname(file), spec.replace(/\.js$/, ".ts"))), seen)]
      : [spec],
  );
};

/** The test runner, by package or by one of this app's own test configs. */
const TEST_RUNNER = /^vitest(\/|$)|(^|\/)vitest(\.[\w-]+)?\.config(\.[jt]s)?$/;

describe("B0 · package boundaries", () => {
  it("finds sources recursively, including subdirectories", () => {
    // Not `length > 0`: `index.ts` is top-level, so that passes even with a
    // non-recursive readdir. Naming the nested file is what actually proves it,
    // and it is what fails first if `{ recursive: true }` is ever dropped. A
    // real view, not a placeholder kept only to be found — and a `.tsx`, so
    // the `isSource` filter is proven to admit the extension every view uses.
    expect(sources("todo-ui").map((s) => s.file)).toContain(
      "todo-ui/src/views/list-view.tsx",
    );
  });

  describe("todo-core is the UI-free layer", () => {
    it("names no ui:* command", () => {
      for (const { file, code } of sources("todo-core")) {
        expect(code, `${file} must not reference ui:* commands`).not.toMatch(/["'`]ui:/);
      }
    });

    it("imports nothing from todo-app or todo-ui", () => {
      for (const { file, code } of sources("todo-core")) {
        expect(code, `${file} must not import the app layer`).not.toMatch(importOf("app"));
        expect(code, `${file} must not import the ui layer`).not.toMatch(importOf("ui"));
      }
    });

    it("touches no DOM global", () => {
      for (const { file, code } of sources("todo-core")) {
        expect(code, `${file} must not touch the DOM`).not.toMatch(DOM_GLOBALS);
      }
    });
  });

  describe("todo-app is the view-free layer", () => {
    it("imports nothing from todo-ui", () => {
      for (const { file, code } of sources("todo-app")) {
        expect(code, `${file} must not import the ui layer`).not.toMatch(importOf("ui"));
      }
    });

    it("touches no DOM global", () => {
      for (const { file, code } of sources("todo-app")) {
        expect(code, `${file} must not touch the DOM`).not.toMatch(DOM_GLOBALS);
      }
    });
  });

  describe("todo-ui reaches the core only through the app layer", () => {
    // Spec §1.1: "Views know only models. Nothing else. Never." todo-ui needs
    // todo-app for model types, so a blanket ban is wrong; the separation is
    // the models-only entry point, `@todo/app/models`.
    it("reaches todo-app only through @todo/app/models — never a controller", () => {
      for (const { file, code } of sources("todo-ui")) {
        expect(code, `${file} must import todo-app only as "@todo/app/models"`).not.toMatch(BEYOND_MODELS);
      }
    });

    it("keeps @todo/app/models free of controllers, bootstrap and the token", async () => {
      // The grep above is only as good as the entry it points at: if models.ts
      // ever re-exported a controller, the rule would still pass. So check what
      // the entry actually exports, transitive re-exports included.
      const names = Object.keys(await import("@todo/app/models"));
      expect(names, "the entry must carry the models a view renders").toEqual(
        expect.arrayContaining(["TodoListModel", "TodoListInput", "MenuModel", "uiShowList"]),
      );
      for (const name of names) {
        expect(name, `@todo/app/models must not export ${name}`).not.toMatch(
          /Controller|bootstrap|ViewsReady|^expect/,
        );
      }
    });

    it("never imports todo-core", () => {
      for (const { file, code } of sources("todo-ui")) {
        expect(code, `${file} must not import the core directly`).not.toMatch(importOf("core"));
      }
    });

    it("touches the bus only in the adapter", () => {
      // Spec §4.3: a view deriving menu items from the registry would be a
      // layering violation. Only view-adapter.ts may name the bus.
      for (const { file, code } of sources("todo-ui")) {
        if (file.endsWith("view-adapter.ts")) continue;
        expect(code, `${file} must not name Commands or CommandsRegistry`).not.toMatch(
          /\b(Commands|CommandsRegistry)\b/,
        );
      }
    });

    it("holds for VIEW suites too — a suite rendering views imports no todo-core", () => {
      // A suite that renders the React views (`@todo/ui`, or a view by path)
      // tests what a view knows, and a view knows only models. A suite taking
      // only `@todo/ui/adapter` tests the bus protocol, which spans layers by
      // nature — it may boot a real `MemTodoApi` and name `todosAdd`.
      const suites = allSuites().filter(({ code }) => usesReactEntry(code));
      // The same empty-loop shape the recursion guard above exists for: if the
      // discovery ever finds nothing, the loop below asserts nothing and passes.
      expect(suites.length, "found no view suite — the check below would be vacuous").toBeGreaterThan(0);
      for (const { file, code } of suites) {
        expect(code, `${file} must not import the core directly`).not.toMatch(importOf("core"));
      }
    });
  });

  describe("the view layer's adapter entry keeps headless suites headless", () => {
    it("view-adapter.ts imports the bus and the registry — no React, and nothing relative", () => {
      const adapter = sources("todo-ui").find(({ file }) => file === "todo-ui/src/view-adapter.ts");
      expect(adapter, "the adapter entry this rule guards").toBeDefined();
      const specs = specifiers(adapter!.code);
      expect(specs.length, "found no import in view-adapter.ts — the check below would be vacuous").toBeGreaterThan(0);
      for (const spec of specs) {
        expect(spec, `view-adapter.ts must not import "${spec}"`).toMatch(ADAPTER_MAY_IMPORT);
      }
    });

    it("the node project refuses to LOAD React, react-dom or the kit — by name, and through the composition root", async () => {
      // The grep below reads what a suite names; a suite that imports
      // `src/app.ts` names no `@todo/ui` and still loads every view. So the
      // node project's own resolver refuses the React stack (`vitest.config.ts`),
      // and this proves on every run that it does — remove the plugin and
      // these imports succeed.
      //
      // Through a variable: Vite resolves a literal `import("react")` while
      // transforming this file, and the refusal would then fail B0 as a whole
      // instead of this one assertion.
      const load = (spec: string) => import(/* @vite-ignore */ spec);
      const refused = /headless stays headless/;
      for (const spec of ["react", "react-dom/client", "@statewalker/ui.view.shadcn"]) {
        await expect(load(spec), spec).rejects.toThrow(refused);
      }
      await expect(load("../../src/app.js"), "the composition root pulls in the React views").rejects.toThrow(refused);
      // A control that refuses everything proves nothing: the adapter loads.
      await expect(load("@todo/ui/adapter")).resolves.toHaveProperty("ViewAdapter");
    });

    it("a node suite, or the test support it loads, takes @todo/ui only as @todo/ui/adapter", () => {
      const modules = headlessModules();
      const users = modules.filter(({ code }) => specifiers(code).some((s) => /todo[-/]ui\b/.test(s)));
      expect(users.length, "found no headless user of the view layer — the check below would be vacuous").toBeGreaterThan(0);
      for (const { file, code } of modules) {
        for (const spec of specifiers(code)) {
          expect(reachesUiBeyondAdapter(spec), `${file} imports "${spec}"; a node suite takes "@todo/ui/adapter"`).toBe(false);
        }
      }
    });
  });

  describe("the rules can fail — negative controls against known-bad fixtures", () => {
    // A one-time plant proves a rule once. These prove it on every run, so a
    // regex weakened later fails HERE instead of passing every real file.
    it("the models-only rule rejects a controller, bootstrap or the barrel — by alias and by relative path", () => {
      for (const bad of [
        'import { ListController } from "@todo/app";',
        'export * from "@todo/app";',
        'import { bootstrap } from "@todo/app/bootstrap";',
        'import { ListController } from "../../todo-app/src/list-controller.js";',
        'import type { TodoListModel } from "../../../todo-app/src/models.js";',
      ]) {
        expect(bad).toMatch(BEYOND_MODELS);
      }
      expect('import { TodoListModel, uiShowList } from "@todo/app/models";').not.toMatch(BEYOND_MODELS);
    });

    it("the headless rule rejects the React entry, by alias and by relative path", () => {
      const bad = specifiers(
        [
          'import { ViewAdapter } from "@todo/ui";',
          'import { ListView } from "@todo/ui/views";',
          'import { ViewAdapter } from "../../lib/todo-ui/src/index.js";',
          'import { MenuView } from "../../lib/todo-ui/src/views/menu-view.js";',
        ].join("\n"),
      );
      expect(bad).toHaveLength(4);
      for (const spec of bad) expect(reachesUiBeyondAdapter(spec), spec).toBe(true);
      for (const good of ["@todo/ui/adapter", "../../lib/todo-ui/src/view-adapter.js", "@todo/app/models"]) {
        expect(reachesUiBeyondAdapter(good), good).toBe(false);
      }
    });

    it("the adapter whitelist rejects react, react-dom and a relative import", () => {
      const bad = specifiers(
        'import { useRef } from "react";\nimport { createRoot } from "react-dom/client";\nexport * from "./use-model.js";',
      );
      expect(bad).toEqual(["react", "react-dom/client", "./use-model.js"]);
      for (const spec of bad) expect(spec).not.toMatch(ADAPTER_MAY_IMPORT);
    });

    it("the model exemption is by location: todo-app's *-model.ts, not a suffix anywhere", () => {
      expect(isModelModule("todo-app/src/todo-model.ts")).toBe(true);
      expect(isModelModule("todo-ui/src/use-model.ts")).toBe(false);
      expect(isModelModule("todo-ui/src/views/selection-model.ts")).toBe(false);
      expect(isModelModule("todo-core/src/api-model.ts")).toBe(false);
    });

    it("the view-side rule rejects every controller-side reference — called, bracketed or spaced — and no view-side one", () => {
      for (const bad of [
        "model.replaceTodos(model.todos);",
        "model.input.takePending();",
        "model . reportOutcome(undefined);",
        'model.input["takeToggles"]();',
        "const drain = model.input.takeRemovals;",
        "model.fromJSON({ todos: [] });",
        "model.notify();",
      ]) {
        expect(bad).toMatch(CONTROLLER_CALL);
      }
      for (const good of [
        "model.input.queueSubmit(title);",
        "useModel(model, (m) => m.visible(), shallowEqual);",
        'import { NotifyView } from "./views/notify-view.js";',
        "const takeover = model.input.requestToggle;",
      ]) {
        expect(good).not.toMatch(CONTROLLER_CALL);
      }
    });

    it("the build-config rule rejects vitest and this app's own test configs — not the shared table", () => {
      for (const bad of ["vitest/config", "vitest", "./vitest.config.js", "./vitest.browser.config.ts"]) {
        expect(bad).toMatch(TEST_RUNNER);
      }
      for (const good of ["./aliases.js", "vite", "@vitejs/plugin-react", "@tailwindcss/vite"]) {
        expect(good).not.toMatch(TEST_RUNNER);
      }
    });

    it("the composition-root rule flags the core, the app and the React entry together, by alias or relative path — not the adapter, not two", () => {
      // The core's specifiers are assembled, not spelled: this file names
      // `@todo/ui` in its fixtures, and "a view suite must not name the core"
      // (above) reads this file too.
      const core = ["@todo", "core"].join("/");
      const coreByPath = ["../lib/todo", "core/src/index.js"].join("-");
      for (const bad of [
        `import { MemTodoApi } from "${core}";\nimport { bootstrap } from "@todo/app";\nimport { registerViews } from "@todo/ui";`,
        `import { MemTodoApi } from "${coreByPath}";\nimport { bootstrap } from "@todo/app";\nimport { ListView } from "../lib/todo-ui/src/views/list-view.js";`,
      ]) {
        expect(knowsEveryLayer(bad), bad).toBe(true);
      }
      for (const good of [
        `import { MemTodoApi } from "${core}";\nimport { bootstrap } from "@todo/app";\nimport { ViewAdapter } from "@todo/ui/adapter";`,
        'import { bootstrap } from "@todo/app";\nimport { registerViews } from "@todo/ui";',
      ]) {
        expect(knowsEveryLayer(good), good).toBe(false);
      }
    });

    it("the view-suite rule binds a suite taking the React entry — not one taking only the adapter", () => {
      expect(usesReactEntry('import { ListView } from "@todo/ui";')).toBe(true);
      expect(usesReactEntry('import { ListView } from "../../lib/todo-ui/src/views/list-view.js";')).toBe(true);
      expect(usesReactEntry('import { ViewAdapter } from "@todo/ui/adapter";')).toBe(false);
      expect(usesReactEntry('import { TodoListModel } from "@todo/app/models";')).toBe(false);
    });
  });

  describe("the composition root is the only module that wires the core to the views", () => {
    // `src/app.ts` imports the core (the api), the app (bootstrap, models) and
    // the ui (the React views) — legitimately: wiring them is its whole job.
    // That is an exemption scoped to ONE file, not a relaxation of any rule
    // above: the per-library rules still apply to every `lib/` file, and
    // none of them reads `src/`. What this adds is the other half — nothing
    // else may import all three with the ui as its React entry: no library,
    // no suite, no test support, and not the page entry `src/main.tsx`, which
    // only calls `startApp`. A headless suite over `@todo/ui/adapter` is not
    // counted (see `knowsEveryLayer`).
    it("only src/app.ts imports todo-core, todo-app and todo-ui's React entry together", () => {
      const everything = [
        ...sources("todo-core"),
        ...sources("todo-app"),
        ...sources("todo-ui"),
        ...pageSources(),
        // B0 itself spells all three as fixtures; it is the grep, not an importer.
        ...headlessModules(),
        ...allSuites().filter(({ file }) => file.endsWith(".tsx")),
      ];
      expect(everything.map(({ file }) => file), "the page's modules are scanned").toEqual(
        expect.arrayContaining(["src/app.ts", "src/main.tsx"]),
      );
      const roots = everything.filter(({ code }) => knowsEveryLayer(code)).map(({ file }) => file);
      // Equality, not "is a subset": if app.ts stopped matching, the pattern
      // (or the layout) has drifted and this check would be asserting nothing.
      expect(roots, "only the composition root may import every layer").toEqual(["src/app.ts"]);
    });
  });

  describe("only models notify, and only models are mutated", () => {
    // Spec §4.8. A controller that writes fields and notifies for itself can
    // publish a half-applied state — and the reconciliation in §4.2 then runs
    // against it. A `todo-app/src/*-model.ts` file is the only place
    // `notify()` may appear — `use-model.ts` included in the ban.
    const nonModels = () =>
      [...sources("todo-core"), ...sources("todo-app"), ...sources("todo-ui")].filter(
        ({ file }) => !isModelModule(file),
      );

    it("the exemption reaches the model modules, and nothing else", () => {
      const exempt = [...sources("todo-core"), ...sources("todo-app"), ...sources("todo-ui")]
        .map(({ file }) => file)
        .filter(isModelModule);
      expect(exempt, "the files these rules skip").toEqual(["todo-app/src/todo-model.ts"]);
    });

    it("calls notify() only from a model", () => {
      for (const { file, code } of nonModels()) {
        expect(code, `${file} must not call notify(); use a mutator on the model`).not.toMatch(
          /\.notify\s*\(/,
        );
      }
    });

    it("never assigns a model field — on the input sub-model OR the outer model", () => {
      // Guarding only `.input.` left the outer model open: a controller writing
      // `this._model.todos = [...]` bypasses `replaceTodos`, fires no notify,
      // and every subscriber keeps an empty list — with this suite green.
      for (const { file, code } of nonModels()) {
        expect(code, `${file} must not assign a model field directly; use a mutator`).not.toMatch(
          MODEL_FIELD_WRITE,
        );
        expect(code, `${file} must not assign through \`.input.\`; use a mutator`).not.toMatch(
          /\.input\.\w+\s*(=(?![=>])|\+\+|--)/,
        );
      }
    });
  });

  describe("a view calls only the view-side mutators", () => {
    // "The view writes only `input`" is not an object boundary on its own: a
    // view holds the OUTER model, so it can call `replaceTodos`,
    // `reportOutcome` or a `take*()` drain — and a write that stores equal
    // data (`model.replaceTodos(model.todos)`) leaves every `toJSON()`
    // snapshot in the browser suites unchanged. This is what checks it.
    it("the split is derived from the model classes, and the allow-list names only methods that exist", () => {
      const methods = modelMethods();
      expect(CONTROLLER_SIDE, "the controller-side set is found, not assumed").toEqual(
        expect.arrayContaining(["replaceTodos", "reportOutcome", "takePending", "takeToggles", "takeRemovals", "fromJSON"]),
      );
      for (const name of VIEW_MAY_CALL) {
        expect(methods.has(name), `VIEW_MAY_CALL names "${name}", which no model has`).toBe(true);
      }
    });

    it("todo-ui never names a controller-side model method", () => {
      for (const { file, code } of sources("todo-ui")) {
        expect(code, `${file} may call only the view-side mutators: ${[...VIEW_MAY_CALL].join(", ")}`).not.toMatch(
          CONTROLLER_CALL,
        );
      }
    });
  });

  describe("the bootstrap-order token cannot be forged", () => {
    // Spec §4.12. `ViewsReady` has a private constructor, but `_mint()` is a
    // public static — it has to be, since `bootstrap.ts` is another module. The
    // barrel exports the type only; this grep is what closes the rest: a
    // `todo-app` file, or a suite reaching in by relative path, that mints a
    // token can activate a controller with no view layer registered.
    const MINT = /\b_mint\b/;
    const MINTERS = ["todo-app/src/views-ready.ts", "todo-app/src/bootstrap.ts"];

    it("mints only in views-ready.ts and bootstrap.ts", () => {
      const everything = [
        ...sources("todo-core"),
        ...sources("todo-app"),
        ...sources("todo-ui"),
        // B0 itself names the pattern; it is the grep, not a minter.
        ...allSuites().filter(({ file }) => !file.startsWith("B0-boundaries/")),
      ];
      const minters = everything.filter(({ code }) => MINT.test(code)).map(({ file }) => file);
      // Equality, not "is a subset": if bootstrap stopped minting, the pattern
      // (or the file layout) has drifted and this check would be asserting nothing.
      expect(minters.sort(), "only bootstrap may mint a ViewsReady").toEqual([...MINTERS].sort());
    });

    it("holds the ViewsReady CLASS only in bootstrap.ts and list-controller.ts", () => {
      // Confining `_mint` is not enough on its own: anyone holding the class
      // value can build a look-alike with `Object.create(ViewsReady.prototype)`,
      // which passes `instanceof` and never names `_mint`. So confine who can
      // import the module at all — the barrel only as `export type`.
      const importsIt = new RegExp(`${QUOTE}${NOT_QUOTE}*\\bviews-ready(\\.js)?${QUOTE}`);
      const everything = [
        ...sources("todo-core"),
        ...sources("todo-app"),
        ...sources("todo-ui"),
        ...allSuites().filter(({ file }) => !file.startsWith("B0-boundaries/")),
      ];
      const holders = everything.filter(({ code }) => importsIt.test(code)).map(({ file }) => file);
      expect(holders.sort(), "only bootstrap and the controller may import views-ready").toEqual([
        "todo-app/src/bootstrap.ts",
        "todo-app/src/index.ts",
        "todo-app/src/list-controller.ts",
      ]);
      const barrel = everything.find(({ file }) => file === "todo-app/src/index.ts")?.code ?? "";
      const lines = barrel.split("\n").filter((line) => importsIt.test(line));
      expect(lines, "the barrel may re-export ViewsReady as a type, and only as a type").toEqual([
        'export type { ViewsReady } from "./views-ready.js";',
      ]);
    });
  });

  describe("subscribers use named channels, not bare onUpdate", () => {
    // Spec §4.10. `onUpdate` wakes a subscriber for every field, which is the
    // shape that makes self-wake dangerous. `useModel` is the one legitimate
    // exception: it supplies its own selector.
    it("never calls onUpdate outside a model or the React binding", () => {
      const offenders = [...sources("todo-core"), ...sources("todo-app"), ...sources("todo-ui")].filter(
        ({ file }) => !isModelModule(file) && file !== REACT_BINDING,
      );
      expect(offenders.map(({ file }) => file), "the binding is checked by name — a rename must not exempt it silently").not.toContain(
        REACT_BINDING,
      );
      expect(
        sources("todo-ui").map(({ file }) => file),
        "the React binding this rule exempts still exists",
      ).toContain(REACT_BINDING);
      for (const { file, code } of offenders) {
        expect(code, `${file} must subscribe to a named channel, not onUpdate`).not.toMatch(
          /\.onUpdate\s*\(/,
        );
      }
    });
  });

  describe("the build config stays out of the test runner", () => {
    // `vite.config.ts` once took the alias table from `vitest.config.ts`, so
    // every production build loaded `vitest/config`. The table now lives in
    // `aliases.ts`; this keeps it there.
    it("vite.config.ts reaches no vitest module, directly or through a local import", () => {
      const specs = reachableSpecifiers("vite.config.ts");
      expect(specs, "the shared alias table is followed — the check below is not vacuous").toContain("./aliases.js");
      for (const spec of specs) {
        expect(spec, `vite.config.ts reaches "${spec}"`).not.toMatch(TEST_RUNNER);
      }
    });
  });

  describe("the external service knows nothing about the app", () => {
    // Spec §4.6. TodoApi is a data-access port. The moment it names a command,
    // a model or the bus, the layering is nominal rather than real.
    it("keeps TodoApi and its adapters free of commands, models and the bus", () => {
      // NO word boundaries: `\bModel\b` does not match `TodoListModel`, and
      // `\bCommand\b` matches neither `CommandDeclaration` nor `CommandError` —
      // which left the check near-inert. A substring match costs nothing here,
      // since a data-access port has no business spelling either. The imports
      // are checked too: `todosAdd` from the sibling declarations names no
      // "Command" and still makes the port know the bus.
      const ports = sources("todo-core").filter(({ file }) => /types\.ts$|-api\.ts$/.test(file));
      expect(ports.map((p) => p.file), "the port files this check covers").toEqual(
        expect.arrayContaining(["todo-core/src/types.ts", "todo-core/src/mem-todo-api.ts"]),
      );
      for (const { file, code } of ports) {
        expect(code, `${file} must not name a command, model or bus`).not.toMatch(
          /Command|Model|BaseClass/,
        );
        expect(code, `${file} must not import the bus, the model base, or the declarations`).not.toMatch(
          /@statewalker\/shared-(commands|baseclass)|["']\.\/(declarations|todo-commands)(\.js)?["']/,
        );
      }
    });
  });

  describe("registrations are owned by a registry", () => {
    // Spec §4.9. A hand-rolled disposer array unwinds in the wrong order and
    // strands everything after the first listener that throws.
    it("uses newRegistry rather than a hand-rolled disposer array", () => {
      for (const { file, code } of [...sources("todo-core"), ...sources("todo-app"), ...sources("todo-ui")]) {
        expect(code, `${file} must not hand-roll a disposer array`).not.toMatch(
          /(_offs|offs)\s*(:|=)\s*(\(\)\s*=>\s*void\)\[\]|\[\])/,
        );
      }
    });
  });
});
