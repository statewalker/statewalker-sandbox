import { readdirSync, readFileSync } from "node:fs";
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

/** A package's suites, found by what they import — alias or relative path — not by directory. */
const suitesUsing = (pkg: string) => allSuites().filter(({ code }) => importOf(pkg).test(code));

const DOM_GLOBALS = /\b(document|window|HTMLElement|navigator)\b/;

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
      const beyondModels = new RegExp(
        `@todo/app(?!/models${QUOTE})|${QUOTE}\\.\\.?/${NOT_QUOTE}*\\btodo-app/`,
      );
      for (const { file, code } of sources("todo-ui")) {
        expect(code, `${file} must import todo-app only as "@todo/app/models"`).not.toMatch(beyondModels);
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

    it("holds for todo-ui SUITES too — a suite can breach a boundary as easily as a module", () => {
      const suites = suitesUsing("ui");
      // The same empty-loop shape the recursion guard above exists for: if the
      // discovery ever finds nothing, the loop below asserts nothing and passes.
      expect(suites.length, "found no todo-ui suite — the check below would be vacuous").toBeGreaterThan(0);
      for (const { file, code } of suites) {
        expect(code, `${file} must not import the core directly`).not.toMatch(importOf("core"));
      }
    });
  });

  describe("only models notify, and only models are mutated", () => {
    // Spec §4.8. A controller that writes fields and notifies for itself can
    // publish a half-applied state — and the reconciliation in §4.2 then runs
    // against it. A `*-model.ts` file is the only place `notify()` may appear.
    const nonModels = () =>
      [...sources("todo-core"), ...sources("todo-app"), ...sources("todo-ui")].filter(
        ({ file }) => !file.endsWith("-model.ts"),
      );

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
        ({ file }) => !file.endsWith("-model.ts") && !file.endsWith("use-model.ts"),
      );
      for (const { file, code } of offenders) {
        expect(code, `${file} must subscribe to a named channel, not onUpdate`).not.toMatch(
          /\.onUpdate\s*\(/,
        );
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
