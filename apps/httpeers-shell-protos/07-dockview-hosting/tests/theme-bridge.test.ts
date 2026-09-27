// DERIVED-FROM-NOTE: 34 §2 (both sides expose semantic variables, so a pure
//                            CSS bridge is enough)
// DERIVED-FROM-NOTE: 34 §3 (a hand-written coverage test proves nothing —
//                            62 semantic variables, 24 covered, tests green)
// DERIVED-FROM-NOTE: 34 §4 (colours only; composite values may carry structure;
//                            one radius)
// DERIVED-FROM-NOTE: 39 (mutation testing found 7b checked the bridge against
//                        a list written in the same file)
//
// Rung 7b: can Dockview's theme be driven by shadcn/Basecoat tokens?
//
// EVERY expectation below is extracted from the installed dockview-core
// bundle or from the bridge's own stylesheet text. There is deliberately no
// list of Dockview variables anywhere in this file: that is the exact defect
// note 34 §3 and note 39 record.

import { beforeEach, describe, expect, it } from "vitest";
import {
  BRIDGED_VARIABLES,
  DOCKVIEW_SHADCN_BRIDGE,
  installBridge,
  REQUIRED_TOKENS,
  SHADCN_THEME_CLASS,
  UNBRIDGED_BY_DESIGN,
} from "../../lib/theme-bridge.js";
import {
  COLOUR_VALUE,
  colourBearingVariables,
  consumedSemanticVariables,
  consumedVariables,
  declaredValues,
  extractDockviewStylesheet,
  isPaletteVariable,
  parseDeclarations,
  referencedTokens,
} from "../src/dockview-css.js";

const DOCKVIEW_CSS = extractDockviewStylesheet();
const CONSUMED_SEMANTIC = consumedSemanticVariables(DOCKVIEW_CSS);
const COLOUR_BEARING = colourBearingVariables(DOCKVIEW_CSS);
const BRIDGE_DECLARATIONS = parseDeclarations(DOCKVIEW_SHADCN_BRIDGE);
const DECLARED_IN_BRIDGE = new Set(BRIDGE_DECLARATIONS.map(([name]) => name));

const sorted = (values: Iterable<string>): string[] => [...values].sort();
const missing = (from: Iterable<string>, present: Set<string>): string[] =>
  sorted([...from].filter((v) => !present.has(v)));

beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("the fixture is real", () => {
  it("recovers a stylesheet Dockview never ships as a file", () => {
    // Guards every assertion below against passing vacuously: an extraction
    // that silently produced "" would make coverage trivially complete.
    expect(DOCKVIEW_CSS.length).toBeGreaterThan(100_000);
    expect(DOCKVIEW_CSS).toContain(".dv-tab");
    expect(CONSUMED_SEMANTIC.size).toBeGreaterThan(50);
    expect(COLOUR_BEARING.size).toBeGreaterThan(20);
  });

  it("separates the semantic surface from Dockview's own per-theme palettes", () => {
    const all = consumedVariables(DOCKVIEW_CSS);
    const palette = [...all].filter(isPaletteVariable);
    // The palettes (`--dv-color-abyss-*`, `--dv-color-gh-*`, ...) belong to
    // Dockview's bundled themes, which the bridge REPLACES rather than
    // extends (note 34 §2), so they are correctly out of scope.
    expect(palette.length).toBeGreaterThan(0);
    for (const name of palette) expect(DECLARED_IN_BRIDGE.has(name)).toBe(false);
  });
});

describe("coverage, derived from Dockview's CSS", () => {
  it("accounts for EVERY semantic variable Dockview consumes", () => {
    // The strong test of note 34 §3: each variable is either bridged or
    // explicitly declared unbridged. A Dockview upgrade that introduces a
    // variable fails here rather than silently rendering unthemed, and a
    // bridge entry for a variable Dockview no longer reads fails too.
    const accounted = new Set([...DECLARED_IN_BRIDGE, ...UNBRIDGED_BY_DESIGN]);
    expect(missing(CONSUMED_SEMANTIC, accounted)).toEqual([]);
    expect(missing(accounted, CONSUMED_SEMANTIC)).toEqual([]);
    expect(sorted(accounted)).toEqual(sorted(CONSUMED_SEMANTIC));
  });

  it("bridges every variable Dockview gives a colour to", () => {
    // "Colour-bearing" is derived from the values Dockview's own themes
    // assign, not from the variable's name: `--dv-tab-group-color` reads as a
    // colour and carries no colour default, and a name heuristic would
    // misclassify it.
    expect(missing(COLOUR_BEARING, DECLARED_IN_BRIDGE)).toEqual([]);
  });

  it("declares nothing colour-bearing as unbridged-by-design", () => {
    // Note 34 §4: metrics and timings keep Dockview's defaults, because
    // shadcn has no equivalent. That is a decision about NON-colours only.
    const wrongly = [...UNBRIDGED_BY_DESIGN].filter((v) => COLOUR_BEARING.has(v));
    expect(wrongly).toEqual([]);
  });

  it("every unbridged-by-design variable really is a metric or timing", () => {
    const values = declaredValues(DOCKVIEW_CSS);
    for (const name of UNBRIDGED_BY_DESIGN) {
      for (const value of values.get(name) ?? []) {
        expect(COLOUR_VALUE.test(value), `${name}: ${value}`).toBe(false);
      }
    }
  });

  it("keeps the exported BRIDGED_VARIABLES list honest about the stylesheet", () => {
    // The exported list is documentation of the CSS, and documentation drifts.
    expect(sorted(BRIDGED_VARIABLES)).toEqual(sorted(DECLARED_IN_BRIDGE));
  });
});

describe("the bridge maps to tokens, never to colours", () => {
  it("references a token in every value", () => {
    expect(BRIDGE_DECLARATIONS.length).toBe(DECLARED_IN_BRIDGE.size);
    for (const [name, value] of BRIDGE_DECLARATIONS) {
      expect(value, name).toMatch(/var\(\s*--/);
    }
  });

  it("contains no literal colour", () => {
    // Note 34 §4: composite values may carry structure —
    // `--dv-drag-over-border: 1px dashed var(--ring)` mixes a width and a
    // keyword with a token — so this forbids literal COLOURS, not literals.
    const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(/i;
    for (const [name, value] of BRIDGE_DECLARATIONS) {
      expect(LITERAL_COLOUR.test(value), `${name}: ${value}`).toBe(false);
    }
  });

  it("declares exactly the shadcn tokens it depends on", () => {
    // Derived from the stylesheet, so a value added with a new token that
    // Basecoat may not define cannot slip past REQUIRED_TOKENS.
    expect(sorted(REQUIRED_TOKENS)).toEqual(sorted(referencedTokens(BRIDGE_DECLARATIONS)));
  });

  it("maps all three Dockview radii onto shadcn's single --radius", () => {
    // Note 34 §4. Derived: find the radius variables Dockview consumes, and
    // require each to resolve to the one token shadcn exposes.
    const radii = [...CONSUMED_SEMANTIC].filter((v) => v.endsWith("-radius"));
    const bridgedRadii = radii.filter((v) => DECLARED_IN_BRIDGE.has(v));
    expect(bridgedRadii.length).toBeGreaterThan(1);
    for (const name of bridgedRadii) {
      const value = BRIDGE_DECLARATIONS.find(([n]) => n === name)?.[1];
      expect(value, name).toBe("var(--radius)");
    }
  });
});

describe("installing the bridge", () => {
  it("defines exactly one class, and it is the exported one", () => {
    const selectors = [...DOCKVIEW_SHADCN_BRIDGE.matchAll(/^\s*(\.[a-z0-9-]+)\s*\{/gm)].map(
      (m) => m[1] as string,
    );
    expect(selectors).toEqual([`.${SHADCN_THEME_CLASS}`]);
  });

  it("appends the stylesheet to the document head", () => {
    const style = installBridge(document);
    expect(style.parentElement).toBe(document.head);
    expect(style.textContent).toBe(DOCKVIEW_SHADCN_BRIDGE);
    expect(document.head.querySelectorAll("style[data-dockview-shadcn-bridge]")).toHaveLength(1);
  });
});
