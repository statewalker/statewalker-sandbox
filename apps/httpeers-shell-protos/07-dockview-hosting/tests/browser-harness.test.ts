// THE HARNESS IS INERT, AND THIS IS THE TEST THAT SAYS SO OUT LOUD.
// Added 2026-09-10 by the Track SH audit.
//
// The work order for this track is emphatic, and it is right:
//
//   "A unit test is not enough here. Note 35 records a bug that 61 unit tests
//   missed, and note 36 a false negative caused by querying the wrong
//   element. A test that builds its own DOM tests the stylesheet, not the
//   integration. `browser-states.mjs` is the harness — port it in this unit,
//   not later."
//
// `lib/browser-states.mjs` was COPIED, not ported. It is 152 lines of real,
// self-asserting Puppeteer and it cannot run: five independent reasons, each
// asserted below. `PROVENANCE.md` says this in prose and is accurate; the
// problem with prose is that the 300-test green run does not mention it, and
// a green run is exactly what note 35 warns is not evidence.
//
// So this file exists to make the gap part of the suite's own output. It does
// NOT assert that the harness works — it asserts, precisely, that it cannot,
// and every assertion INVERTS when the harness is wired up. Wiring it up is
// therefore a change that has to come through here, which is the only way a
// "port it later" stays visible.
//
// WHAT IT WOULD TAKE, scoped rather than half-done:
//   1. two undeclared dependencies (`puppeteer-core`, `@sparticuz/chromium`)
//      plus a Chromium download — a networked install, not a line in a file;
//   2. a `dist/states.html` fixture that does not exist anywhere in this app,
//      carrying a browser bundle of `lib/dock.ts` + `lib/theme-bridge.ts`
//      (TypeScript, so a bundler this app does not configure — `06a` runs the
//      Tailwind CLI and nothing else), the Basecoat stylesheet, and a script
//      that assigns `window.__dock`;
//   3. a `test:browser` script to run it by;
//   4. and `PROVENANCE.md` defect 2 fixed FIRST. `lib/dock.ts` hard-codes
//      `theme: themeLight`, which is the note-35 bug itself, so the harness's
//      central assertion — that the drag overlay's colours FLIP between light
//      and dark — must fail until that is repaired. The harness lands red by
//      construction, and repairing `lib/` is a fix this unit is told not to
//      make (rung 07's tests deliberately pin the defect).
//
// That is a unit of work coupled to a fix outside this one's scope, not a
// loose end to tie off. It is reported, not attempted.
//
// DERIVED-FROM-NOTE: 35-Browser Tests: A Bug 61 Unit Tests Missed
// DERIVED-FROM-NOTE: 36-Browser State Verification: Drag, Dark Mode, Floating Groups

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Resolved from cwd, not import.meta.url: under happy-dom the latter is not a file: URL. */
const fromApp = (p: string) => resolve(process.cwd(), p);
const harness = () => readFileSync(fromApp("lib/browser-states.mjs"), "utf8");
const pkg = () =>
  JSON.parse(readFileSync(fromApp("package.json"), "utf8")) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

describe("the harness is present and is the real note 35/36 article", () => {
  it("is here, and carries the two findings that cost the session the most", () => {
    const src = harness();
    // Not a stub. If this file is ever replaced by a placeholder, the rest of
    // this suite's claims about what is missing stop meaning anything.
    expect(src).toMatch(/setDragInterception\(true\)/);
    expect(src).toMatch(/dv-drop-target-selection/);
    expect(src).toMatch(/dv-resize-container/);
    // And it asserts the FLIP, which is the assertion shape note 35 earned:
    // matching colours mean the bridge never reached the element, and that
    // presented as "looks fine" in light mode.
    expect(src).toMatch(/drag background did not flip/);
  });
});

describe("...and it cannot run, for five independent reasons", () => {
  it("1. names a script to run it by that package.json does not define", () => {
    expect(harness()).toMatch(/Run with: npm run test:browser/);
    expect(Object.keys(pkg().scripts)).not.toContain("test:browser");
  });

  it("2. imports two packages this app does not depend on", () => {
    const src = harness();
    const declared = { ...pkg().dependencies, ...pkg().devDependencies };
    const imported = [...src.matchAll(/^import .* from "([^"]+)"/gm)]
      .map((m) => m[1] as string)
      .filter((s) => !s.startsWith("node:"));
    expect(imported).toEqual(["puppeteer-core", "@sparticuz/chromium"]);
    for (const dep of imported) expect(Object.keys(declared)).not.toContain(dep);
  });

  it("3. loads a dist/states.html fixture that nothing in this app builds", () => {
    expect(harness()).toMatch(/dist\/states\.html/);
    expect(existsSync(fromApp("dist/states.html"))).toBe(false);
    expect(existsSync(fromApp("dist"))).toBe(false);
    // And no script would produce it.
    const scripts = Object.values(pkg().scripts).join(" ");
    expect(scripts).not.toMatch(/states\.html/);
  });

  it("4. reads a window.__dock that nothing ever assigns", () => {
    expect(harness()).toMatch(/window\.__dock/);
    // The whole app, source and fixtures: the only mention is the read.
    const hits = [
      "lib/dock.ts",
      "lib/theme-bridge.ts",
      "lib/mount.ts",
      "06a-tailwind-build/shell.html",
      "06a-tailwind-build/shell-bc.html",
    ].filter((f) => existsSync(fromApp(f)) && readFileSync(fromApp(f), "utf8").includes("__dock"));
    expect(hits).toEqual([]);
  });

  it("5. is a .mjs outside tests/, so the runner never collects it either", () => {
    const config = readFileSync(fromApp("vitest.config.ts"), "utf8");
    expect(config).toMatch(/include:\s*\["\*\*\/tests\/\*\*\/\*\.test\.ts"\]/);
    // i.e. neither the extension nor the location can match. Nothing in this
    // app runs this file by any path.
  });
});

describe("so the claim this suite is allowed to make is narrow", () => {
  it("has no browser test anywhere, which is why 301 green tests are not evidence here", () => {
    // Note 35's bug passed 61 unit tests. This app has more tests than that
    // and the same blind spot, for the same reason: happy-dom resolves no CSS
    // custom property from a stylesheet (asserted in limitations.test.ts), so
    // the assertion class the original failure lived in is unavailable.
    const scripts = pkg().scripts;
    expect(Object.keys(scripts).filter((k) => /browser|e2e|puppeteer|playwright/i.test(k))).toEqual(
      [],
    );
    const deps = { ...pkg().dependencies, ...pkg().devDependencies };
    expect(
      Object.keys(deps).filter((d) => /puppeteer|playwright|chromium|webdriver/i.test(d)),
    ).toEqual([]);
  });

  it("records that PROVENANCE.md's fourth precondition is still unmet", () => {
    // `lib/dock.ts` hard-codes the light theme — defect 2, the note-35 bug
    // itself — so the harness's light/dark flip cannot pass even once the
    // other four reasons are cleared. packaging.test.ts pins the same line
    // from the other side ("PINS A DEFECT: createShellDock hard-codes
    // themeLight"); this asserts it as a BLOCKER on the harness, which is the
    // fact a reader needs when deciding what to do first.
    const dock = readFileSync(fromApp("lib/dock.ts"), "utf8");
    expect(dock).toMatch(/theme:\s*themeLight/);
    expect(readFileSync(fromApp("lib/theme-bridge.ts"), "utf8")).not.toMatch(/shadcnTheme/);
  });
});
