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

/** A package's suites, found by the alias they import — not by directory. */
const suitesUsing = (pkg: string) =>
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
    })
    .filter(({ code }) => new RegExp(`@todo/${pkg}`).test(code));

const DOM_GLOBALS = /\b(document|window|HTMLElement|navigator)\b/;

describe("B0 · package boundaries", () => {
  it("finds sources recursively, including subdirectories", () => {
    // Guards the suite itself: a non-recursive readdir returns only top-level
    // files, and every assertion below would then pass vacuously for nested code.
    expect(sources("todo-ui").length).toBeGreaterThan(0);
  });

  describe("todo-core is the UI-free layer", () => {
    it("names no ui:* command", () => {
      for (const { file, code } of sources("todo-core")) {
        expect(code, `${file} must not reference ui:* commands`).not.toMatch(/["'`]ui:/);
      }
    });

    it("imports nothing from todo-app or todo-ui", () => {
      for (const { file, code } of sources("todo-core")) {
        expect(code, `${file} must not import the app or ui layer`).not.toMatch(/@todo\/(app|ui)/);
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
        expect(code, `${file} must not import the ui layer`).not.toMatch(/@todo\/ui/);
      }
    });

    it("touches no DOM global", () => {
      for (const { file, code } of sources("todo-app")) {
        expect(code, `${file} must not touch the DOM`).not.toMatch(DOM_GLOBALS);
      }
    });
  });

  describe("todo-ui reaches the core only through the app layer", () => {
    it("never imports todo-core", () => {
      for (const { file, code } of sources("todo-ui")) {
        expect(code, `${file} must not import the core directly`).not.toMatch(/@todo\/core/);
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
      for (const { file, code } of suitesUsing("ui")) {
        expect(code, `${file} must not import the core directly`).not.toMatch(/@todo\/core/);
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

    it("never assigns through `.input.`, which is what a mutator is for", () => {
      for (const { file, code } of nonModels()) {
        expect(code, `${file} must not assign a model field directly`).not.toMatch(
          /\.input\.\w+\s*(=[^=]|\+\+|--)/,
        );
      }
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
      for (const { file, code } of sources("todo-core")) {
        if (!/types\.ts$|-api\.ts$/.test(file)) continue;
        expect(code, `${file} must not name a command, model or bus`).not.toMatch(
          /\b(Command|Commands|CommandsRegistry|BaseClass|Model)\b/,
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
