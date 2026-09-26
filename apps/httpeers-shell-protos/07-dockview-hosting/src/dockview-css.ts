// DERIVED-FROM-NOTE: 31 §3.1 (Dockview's CSS is embedded in the JS as a string)
// DERIVED-FROM-NOTE: 34 §3 (a hand-written coverage test proves nothing —
//                            derive the expectation from the artefact)
//
// The source of truth for every theme-bridge assertion in this rung.
//
// Note 34 recorded that the first version of the bridge covered 24 of 62
// variables while its coverage tests passed, because those tests checked the
// bridge against a list written by hand in the same file. Note 39 recorded
// the same defect surviving mutation testing. So NOTHING in this rung's tests
// may carry a list of Dockview variables: every expectation is extracted from
// the installed `dockview-core` bundle at test time.
//
// Consequence, and the point of doing it this way: a Dockview upgrade that
// adds a variable fails this rung rather than silently rendering unthemed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Root of the installed `dockview-core` package. */
export function dockviewPackageDir(): string {
  return dirname(require.resolve("dockview-core/package.json"));
}

/** Every file in the installed package, as absolute paths. */
export function dockviewPackageFiles(): string[] {
  const root = dockviewPackageDir();
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

/** What `import "dockview-core"` actually resolves to. */
export function dockviewEsmEntry(): string {
  return join(dockviewPackageDir(), "dist", "package", "main.esm.mjs");
}

/** The standalone build — the only file carrying the stylesheet. */
export function dockviewStandaloneBundle(): string {
  return join(dockviewPackageDir(), "dist", "dockview-core.js");
}

const TEXT_CONTENT_MARKER = "s.textContent = ";

/**
 * Recover Dockview's stylesheet from the JS string literal it lives in.
 *
 * There is no `.css` file in the package (note 31 §3.1). The standalone
 * build embeds the whole stylesheet as a double-quoted JS string literal,
 * which is valid JSON, so `JSON.parse` decodes it exactly.
 *
 * This THROWS rather than returning an empty string when the shape changes.
 * A silent empty result would make every coverage test below pass
 * vacuously — which is precisely the failure mode this rung exists to
 * avoid.
 */
export function extractDockviewStylesheet(): string {
  const bundle = readFileSync(dockviewStandaloneBundle(), "utf8");
  const start = bundle.indexOf(TEXT_CONTENT_MARKER);
  if (start < 0) {
    throw new Error(
      'dockview-core no longer embeds its stylesheet as `s.textContent = "..."`; ' +
        "the extraction in 07-dockview-hosting/src/dockview-css.ts must be revisited",
    );
  }
  const from = start + TEXT_CONTENT_MARKER.length;
  const end = bundle.indexOf('";\n', from);
  if (end < 0) throw new Error("unterminated stylesheet literal in dockview-core");
  const css = JSON.parse(bundle.slice(from, end + 1)) as string;
  if (css.length < 100_000 || !css.includes(".dv-tab")) {
    throw new Error(`extracted stylesheet looks wrong: ${css.length} bytes`);
  }
  return css;
}

/** `--dv-*` variables read via `var(...)` anywhere in Dockview's CSS. */
export function consumedVariables(css: string): Set<string> {
  return new Set([...css.matchAll(/var\(\s*(--dv-[a-z0-9-]+)/g)].map((m) => m[1] as string));
}

/**
 * The per-theme palettes (`--dv-color-abyss-*`, `--dv-color-gh-*`, ...).
 * They belong to Dockview's own bundled themes, which the bridge REPLACES
 * rather than extends, so they are not the bridge's business.
 */
export function isPaletteVariable(name: string): boolean {
  return name.startsWith("--dv-color-");
}

/** The semantic surface: what a theme is actually expected to supply. */
export function consumedSemanticVariables(css: string): Set<string> {
  return new Set([...consumedVariables(css)].filter((v) => !isPaletteVariable(v)));
}

/** Every value Dockview's own themes assign to each `--dv-*` variable. */
export function declaredValues(css: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of css.matchAll(/(--dv-[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/g)) {
    const name = m[1] as string;
    const list = out.get(name) ?? [];
    list.push((m[2] as string).trim());
    out.set(name, list);
  }
  return out;
}

/** Anything that reads as a colour, including a reference to a palette entry. */
export const COLOUR_VALUE =
  /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(|var\(\s*--dv-color-|\btransparent\b|\bwhite\b|\bblack\b/i;

/**
 * Variables Dockview's own themes give a COLOUR to. These are the ones a
 * bridge must cover: leaving one out means that affordance keeps Dockview's
 * bundled colour while everything around it moves to the token set.
 *
 * Derived from what Dockview assigns, not from a judgement about the name —
 * `--dv-tab-group-color` is a colour by name but carries no colour default,
 * and would be missed by a name heuristic.
 */
export function colourBearingVariables(css: string): Set<string> {
  const values = declaredValues(css);
  return new Set(
    [...consumedSemanticVariables(css)].filter((v) =>
      (values.get(v) ?? []).some((value) => COLOUR_VALUE.test(value)),
    ),
  );
}

/** `--dv-x: value` pairs declared inside a bridge stylesheet. */
export function parseDeclarations(cssText: string): Array<[string, string]> {
  return [...cssText.matchAll(/^\s*(--dv-[a-z0-9-]+):\s*([^;]+);/gm)].map(
    (m) => [m[1] as string, (m[2] as string).trim()] as [string, string],
  );
}

/** Non-`--dv-` custom properties a stylesheet references — i.e. shadcn tokens. */
export function referencedTokens(declarations: Array<[string, string]>): Set<string> {
  const out = new Set<string>();
  for (const [, value] of declarations) {
    for (const m of value.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      const token = m[1] as string;
      if (!token.startsWith("--dv-")) out.add(token);
    }
  }
  return out;
}
