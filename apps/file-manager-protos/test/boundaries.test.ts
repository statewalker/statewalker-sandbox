import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * C0 — the standing boundary grep.
 *
 * `ui:show-job` sat in `fm-core` from P0 until a grep test caught it at P5. A
 * boundary you do not grep is not a boundary: it is an intention, and this file
 * is the ten lines that turn one into the other. It runs over the ACTUAL files
 * with comments stripped, so a rule cannot be satisfied by a comment claiming
 * to obey it.
 *
 * The DOM check is the newest of the three: "Node-testable with no DOM" was a
 * claim in file 07 that nothing verified.
 */

const sources = (pkg: string): { file: string; code: string }[] =>
  readdirSync(`${pkg}/src`)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({
      file: `${pkg}/src/${file}`,
      // Comments are stripped first: a rule that a comment can satisfy is not a
      // rule. `ui:show-job` is discussed in prose in more than one file here.
      code: readFileSync(`${pkg}/src/${file}`, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""),
    }));

/** Globals that only exist in a browser. Word-bounded to avoid `documentation`. */
const DOM_GLOBALS = /\b(document|window|HTMLElement|customElements|navigator|localStorage)\b/;

describe("C0 · package boundaries", () => {
  describe("fm-core", () => {
    it("names no ui: command", () => {
      for (const { file, code } of sources("fm-core")) {
        expect(code, `${file} must not name a ui: command`).not.toMatch(/ui:/);
      }
    });

    it("imports neither @fm/app nor @fm/ui", () => {
      for (const { file, code } of sources("fm-core")) {
        expect(code, `${file} must not import the app or view layer`).not.toMatch(
          /from\s+["'](@fm\/(app|ui)|\.\.\/\.\.\/fm-(app|ui))/,
        );
      }
    });

    it("touches no DOM global", () => {
      for (const { file, code } of sources("fm-core")) {
        expect(code, `${file} must stay Node-testable with no DOM`).not.toMatch(DOM_GLOBALS);
      }
    });
  });

  describe("fm-app", () => {
    it("imports no @fm/ui", () => {
      for (const { file, code } of sources("fm-app")) {
        expect(code, `${file} must not import the view layer`).not.toMatch(
          /from\s+["'](@fm\/ui|\.\.\/\.\.\/fm-ui)/,
        );
      }
    });

    it("touches no DOM global", () => {
      for (const { file, code } of sources("fm-app")) {
        expect(code, `${file} must stay Node-testable with no DOM`).not.toMatch(DOM_GLOBALS);
      }
    });
  });

  describe("fm-ui", () => {
    it("never imports @fm/core directly", () => {
      for (const { file, code } of sources("fm-ui")) {
        expect(code, `${file} must reach the engine through @fm/app, not around it`).not.toMatch(
          /from\s+["'](@fm\/core|\.\.\/\.\.\/fm-core)/,
        );
      }
    });
  });
});
