import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * C0.5 — the boundary grep extended to the FOURTH source root.
 *
 * `test/boundaries.test.ts` is left byte-for-byte alone: it is the C0 rung's
 * check and the work order names it as the one that must keep passing. This file
 * is the part C0.5 adds, and it exists because C0.5 introduces the exact tension
 * §6.1 forbids resolving by loosening: `fm-core` may touch no DOM global, and
 * this unit's subject is two browser filesystems.
 *
 * THE RESOLUTION IS LAYERING, NOT PERMISSION. P2 already made every storage a
 * `FilesApi` produced by an `AdapterFactory`, so the core never names an adapter.
 * `fm-adapters/` is therefore a root of its own, OUTSIDE `fm-core` and `fm-app`,
 * the browser globals live only in it, and the dependency runs one way:
 * `fm-adapters` imports `fm-core`, never the reverse. Each of those four clauses
 * is a case below.
 *
 * AND IT CLOSES A HOLE THE ORIGINAL GREP HAD. `sources()` there calls
 * `readdirSync(`${pkg}/src`)` and keeps the entries ending in `.ts` — a FLAT
 * read, so a subdirectory is silently skipped. `fm-core/src/adapters/opfs.ts`
 * would have satisfied every rule in that file while touching `navigator`, which
 * is precisely the thing it greps for. The adopted P5 suite's own grep
 * (`readdirSync("src/core")`) has the same shape. Rather than edit either, the
 * flatness they assume is asserted here: a subdirectory under `fm-core/src` or
 * `fm-app/src` now fails a test instead of creating a blind spot.
 */

const ROOTS = ["fm-core", "fm-app", "fm-ui", "fm-adapters"] as const;

const sources = (pkg: string): { file: string; code: string }[] =>
  readdirSync(`${pkg}/src`)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({
      file: `${pkg}/src/${file}`,
      code: readFileSync(`${pkg}/src/${file}`, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""),
    }));

/** The same pattern `test/boundaries.test.ts` uses, so the two cannot drift apart. */
const DOM_GLOBALS = /\b(document|window|HTMLElement|customElements|navigator|localStorage)\b/;

describe("C0.5 · the fourth source root", () => {
  it("keeps fm-core/src and fm-app/src FLAT, so the flat grep is exhaustive", () => {
    // Not a style rule. Both `test/boundaries.test.ts` and the adopted P5 grep
    // read these directories non-recursively; a subdirectory is a file neither of
    // them checks, and the rule they check is the one this unit is most tempted
    // to break.
    for (const pkg of ["fm-core", "fm-app"]) {
      const entries = readdirSync(`${pkg}/src`);
      const directories = entries.filter((e) => statSync(`${pkg}/src/${e}`).isDirectory());
      expect(
        directories,
        `${pkg}/src must stay flat: the boundary greps read it non-recursively, ` +
          `so ${directories.join(", ")} would be unchecked`,
      ).toEqual([]);
    }
  });

  it("puts every DOM global in fm-adapters and nowhere else", () => {
    const withDom = ROOTS.filter((pkg) => sources(pkg).some(({ code }) => DOM_GLOBALS.test(code)));
    // Exactly one root may name a browser global. If `fm-adapters` ever drops off
    // this list the adapters have moved somewhere they should not be; if anything
    // else joins it, the boundary is gone.
    expect(withDom).toEqual(["fm-adapters"]);
  });

  it("never lets fm-core or fm-app import the adapters", () => {
    // The direction of the dependency IS the boundary. An adapter knowing about
    // the engine is the design; the engine knowing about an adapter is what put
    // `ui:show-job` in `fm-core` for five rungs.
    for (const pkg of ["fm-core", "fm-app"]) {
      for (const { file, code } of sources(pkg)) {
        expect(code, `${file} must not reach for an adapter`).not.toMatch(
          /from\s+["'](@fm\/adapters|\.\.\/\.\.\/fm-adapters|\.\/adapters)/,
        );
      }
    }
  });

  it("never lets fm-core or fm-app import an adapter package directly", () => {
    // The named packages, not just the local root: importing
    // `@statewalker/webrun-files-browser` into `fm-core` would bring the browser
    // in through the front door while passing every rule above.
    for (const pkg of ["fm-core", "fm-app"]) {
      for (const { file, code } of sources(pkg)) {
        expect(code, `${file} must only know the FilesApi interface`).not.toMatch(
          /from\s+["']@statewalker\/webrun-files-(browser|node|mem)["']/,
        );
        expect(code, `${file} must not import a node builtin`).not.toMatch(/from\s+["']node:/);
      }
    }
  });

  describe("fm-adapters", () => {
    it("names no ui: command", () => {
      for (const { file, code } of sources("fm-adapters")) {
        expect(code, `${file} must not name a ui: command`).not.toMatch(/ui:/);
      }
    });

    it("imports neither @fm/app nor @fm/ui", () => {
      for (const { file, code } of sources("fm-adapters")) {
        expect(code, `${file} must not import the app or view layer`).not.toMatch(
          /from\s+["'](@fm\/(app|ui)|\.\.\/\.\.\/fm-(app|ui))/,
        );
      }
    });

    it("never mixes a node builtin and a browser package in one file", () => {
      // One file importing both would break whichever of the two vitest projects
      // does not have that half — and the failure arrives as a bundling error with
      // no mention of the boundary it crossed.
      for (const { file, code } of sources("fm-adapters")) {
        const node = /from\s+["']node:/.test(code);
        const browser = /from\s+["']@statewalker\/webrun-files-browser["']/.test(code);
        expect(node && browser, `${file} imports both a node builtin and the browser adapter`).toBe(
          false,
        );
      }
    });

    it("reaches fm-core for types only, never for a DOM-free helper to re-export", () => {
      // `fm-adapters` is allowed to know `fm-core` — that is the direction of the
      // dependency. What it must not do is become a second front door to the
      // engine: nothing here re-exports `runCopyJob`, `JobQueue` or the models, or
      // a consumer could depend on the engine through the adapters and the
      // boundary would have one more edge than it is greppped for.
      for (const { file, code } of sources("fm-adapters")) {
        expect(code, `${file} must not re-export the engine`).not.toMatch(
          /export\s*\{[^}]*\b(runCopyJob|JobQueue|JobModel|CheckpointStore|StorageRegistry)\b/,
        );
      }
    });
  });
});
