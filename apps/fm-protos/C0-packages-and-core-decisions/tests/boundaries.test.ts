import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * C0 — the package boundaries, checked as a fact about the files.
 *
 * `ui:show-job` was declared in fm-core from P0 until a grep test caught it at
 * P5, four rungs later. A boundary you do not grep is not a boundary, so this
 * runs on every commit rather than living inside one rung's suite.
 */
/*
 * Ported to this app's layout: the three packages live under `lib/<pkg>/src`,
 * and each rung's acceptance suite lives in `<rung>/tests` rather than beside
 * the package. Sources resolve directly; a package's SUITES are found by the
 * alias they import, which states the rule the directory used to imply and
 * survives a suite being filed under any rung. `.tsx` is included, so the
 * D2f/D2g view components are covered too.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const isSource = (f: string) => f.endsWith(".ts") || f.endsWith(".tsx");

const sources = (pkg: string) =>
  readdirSync(`${ROOT}lib/${pkg}/src`)
    .filter(isSource)
    .map((f) => ({
      file: `${pkg}/src/${f}`,
      code: stripComments(readFileSync(`${ROOT}lib/${pkg}/src/${f}`, "utf8")),
    }));

/** Every rung suite that reaches for `@fm/<pkg>` — wherever it is filed. */
const suitesUsing = (pkg: string) =>
  readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !["lib", "node_modules"].includes(d.name))
    .flatMap((d) => {
      const dir = `${ROOT}${d.name}/tests`;
      let files: string[] = [];
      try { files = readdirSync(dir).filter(isSource); } catch { return []; }
      return files.map((f) => ({
        file: `${d.name}/tests/${f}`,
        code: stripComments(readFileSync(`${dir}/${f}`, "utf8")),
      }));
    })
    .filter(({ code }) => new RegExp(`@fm/${pkg}`).test(code));

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

describe("package boundaries", () => {
  describe("fm-core is the UI-free layer", () => {
    it("names no ui:* command", () => {
      for (const { file, code } of sources("fm-core")) {
        expect(code, `${file} must not reference ui:* commands`).not.toMatch(/["'`]ui:/);
      }
    });

    it("imports nothing from fm-app or fm-ui", () => {
      for (const { file, code } of sources("fm-core")) {
        expect(code, `${file} must not import the app or ui layer`).not.toMatch(/@fm\/(app|ui)/);
      }
    });

    it("touches no DOM global", () => {
      for (const { file, code } of sources("fm-core")) {
        expect(code, `${file} must stay Node-testable`).not.toMatch(/\b(document|window|HTMLElement)\b/);
      }
    });
  });

  describe("fm-app is the view-free layer", () => {
    it("imports nothing from fm-ui", () => {
      for (const { file, code } of sources("fm-app")) {
        expect(code, `${file} must not import the ui layer`).not.toMatch(/@fm\/ui/);
      }
    });

    it("touches no DOM global", () => {
      for (const { file, code } of sources("fm-app")) {
        expect(code, `${file} must stay Node-testable`).not.toMatch(/\b(document|window|HTMLElement)\b/);
      }
    });
  });

  it("fm-ui reaches the core only through the app layer", () => {
    for (const { file, code } of sources("fm-ui")) {
      expect(code, `${file} must not import fm-core directly`).not.toMatch(/@fm\/core/);
    }
  });

  it("holds for fm-ui TESTS too — a suite can breach a boundary as easily as a module", () => {
    for (const { file, code } of suitesUsing("fm-ui")) {
      expect(code, `${file} must not import fm-core directly`).not.toMatch(/@fm\/core/);
    }
  });
});
