import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { describe, expect, it } from "vitest";

/**
 * B4 · the styling stack reaches the bundle.
 *
 * `apps/byok-config-prototype` lists `@source "../../../packages/ui.view.shadcn/src/**"`
 * — a directory that does not exist. Tailwind scans nothing there and says
 * nothing, the build is green, and every kit component ships unstyled. The only
 * observable is the emitted CSS, so that is what this suite reads: a production
 * build of this app, and a utility class that appears ONLY in the kit's own
 * source (its `button.tsx` `outline` variant — the "Clear completed" button).
 * Nothing in this app spells it, so the one route by which it can reach the
 * bundle is the kit's `./styles` export and the `@source` globs it carries.
 *
 * Node, not the browser project: a browser test cannot run a bundler, and the
 * question is about the build, not about a page.
 */

const APP = fileURLToPath(new URL("../../", import.meta.url));
const INDEX_CSS = join(APP, "src/index.css");
const KIT_STYLES = /^@import\s+["']@statewalker\/ui\.view\.shadcn\/styles["'];[^\n]*\n/m;

/**
 * Spelled in pieces ON PURPOSE. Tailwind's automatic content detection scans
 * this app's directory — this file included — so the literal class name here
 * would emit the rule by itself, and the assertion would pass with the kit's
 * styles gone. The negative control below is what proves it does not.
 */
const KIT_ONLY_CLASS = ["shadow", "xs"].join("-");
const KIT_ONLY_RULE = new RegExp(`\\.${KIT_ONLY_CLASS}\\s*\\{`);

/**
 * A class spelled ONLY in a plain-DOM view (`lib/stats/ui/stats-view.ts`, a `.ts`
 * file): proves Tailwind reaches the non-React views, which the seed's
 * `@source "../lib/**\/*.tsx"` alone would not name. Spelled in pieces for the
 * same reason as the kit class.
 */
const DOM_ONLY_CLASS = ["fill", "emerald", "500"].join("-");
const DOM_ONLY_RULE = new RegExp(`\\.${DOM_ONLY_CLASS}\\s*\\{`);

/** Builds the app into a scratch directory and returns its one emitted stylesheet. */
async function emittedCss(plugins: Plugin[] = []): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "mvc-blueprint-v2-b4-"));
  try {
    await build({
      root: APP,
      configFile: join(APP, "vite.config.ts"),
      logLevel: "silent",
      plugins,
      build: { outDir, emptyOutDir: true },
    });
    const sheets = readdirSync(join(outDir, "assets")).filter((f) => f.endsWith(".css"));
    expect(sheets, "a production build emits exactly one stylesheet").toHaveLength(1);
    return readFileSync(join(outDir, "assets", sheets[0]), "utf8");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** `src/index.css` as it would be if someone dropped the kit's styles import. */
function withoutKitStyles(): Plugin {
  const original = readFileSync(INDEX_CSS, "utf8");
  const stripped = original.replace(KIT_STYLES, "");
  // A control that removes nothing proves nothing.
  expect(stripped, "src/index.css must import the kit's ./styles").not.toBe(original);
  return {
    name: "b4:without-kit-styles",
    enforce: "pre",
    load(id) {
      if (id.split("?")[0] === INDEX_CSS) return stripped;
    },
  };
}

const TAILWIND_IMPORT = /^@import\s+["']tailwindcss["'];/m;
const DOM_VIEWS_SOURCE = /^@source\s+["']\.\.\/lib\/\*\*\/\*\.ts["'];[^\n]*\n/m;

/**
 * `src/index.css` with automatic content detection off and the plain-DOM glob
 * dropped. Automatic detection scans the whole app, so dropping the glob alone
 * would change nothing; with detection off, the glob is the only route.
 */
function withoutDomViewsSource(): Plugin {
  const original = readFileSync(INDEX_CSS, "utf8");
  const stripped = original
    .replace(TAILWIND_IMPORT, '@import "tailwindcss" source(none);')
    .replace(DOM_VIEWS_SOURCE, "");
  expect(original, "src/index.css must name the plain-DOM views").toMatch(DOM_VIEWS_SOURCE);
  expect(original, "src/index.css must import tailwindcss").toMatch(TAILWIND_IMPORT);
  return {
    name: "b4:without-dom-views-source",
    enforce: "pre",
    load(id) {
      if (id.split("?")[0] === INDEX_CSS) return stripped;
    },
  };
}

describe("B4 · the emitted CSS", () => {
  it("contains a utility class that only the shadcn kit's source spells", async () => {
    const css = await emittedCss();
    expect(css, "the app's own theme is in the bundle").toContain("--color-primary");
    expect(
      css,
      `.${KIT_ONLY_CLASS} — reachable only through @statewalker/ui.view.shadcn/styles`,
    ).toMatch(KIT_ONLY_RULE);
  }, 120_000);

  it("and loses it when the kit's ./styles import is removed — the check can fail", async () => {
    // Run on every build, not once by hand: if this app's own files ever start
    // spelling the class, or automatic detection starts reaching the kit some
    // other way, the assertion above stops proving anything — and this fails.
    const css = await emittedCss([withoutKitStyles()]);
    expect(css, "the build itself still succeeds").toContain("--color-primary");
    expect(css).not.toMatch(KIT_ONLY_RULE);
  }, 120_000);

  it("contains a utility class that only a plain-DOM view spells", async () => {
    const css = await emittedCss();
    expect(css, `.${DOM_ONLY_CLASS} — used only by the stats view's SVG bars`).toMatch(
      DOM_ONLY_RULE,
    );
  }, 120_000);

  it("and, with automatic detection off, loses it when the plain-DOM @source is removed — the check can fail", async () => {
    const css = await emittedCss([withoutDomViewsSource()]);
    // `source(none)` also turns off scanning for whatever spells a slash-opacity
    // (`primary/NN`) utility, which is the only route by which `--color-primary`
    // itself (as opposed to `var(--primary)` inlined directly) reaches the
    // bundle — so it disappears here too, and is not a usable "still succeeded"
    // signal under this control. The kit's own class is: its `@source` lives in
    // the kit's OWN styles.css, self-relative and untouched by this edit, so it
    // stays reachable regardless of automatic detection.
    expect(css, "the build itself still succeeds").toMatch(KIT_ONLY_RULE);
    expect(css).not.toMatch(DOM_ONLY_RULE);
  }, 120_000);
});
