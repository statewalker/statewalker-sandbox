import type { Catalog } from "./catalog.js";

/**
 * PROTOTYPE 6b — the catalogue-to-Basecoat mapping.
 *
 * Basecoat is the shadcn/ui design system expressed as Tailwind CSS plus
 * SEMANTIC classes (`btn`, `input`, `card`) rather than utility soup, with
 * no React and no framework runtime. That is why it was chosen over
 * shadcn/ui itself: the shell is vanilla TypeScript, and importing React
 * into a bootstrap shell would contradict the static-hosting constraint.
 *
 * THE REJECT CONDITION for this rung: if the six catalogue components cannot
 * be expressed in Basecoat without inventing a seventh, the catalogue was
 * designed too abstractly. It did not reject.
 *
 * SECURITY NOTE. Classes come from THIS TABLE and nowhere else. A surface
 * may be authored by a foreign peer, so no class name may ever originate in
 * a message — otherwise a peer could position itself over the shell chrome
 * or restyle it arbitrarily. The renderer never reads `class` or
 * `className` from a component.
 */

export interface ComponentClasses {
  /** Class applied to the component's own element. */
  readonly base: string;
  /** Classes selected by the `variant` property, when the component has one. */
  readonly variants?: Readonly<Record<string, string>>;
  /** Classes applied to inner elements the component builds itself. */
  readonly parts?: Readonly<Record<string, string>>;
  /** Values for Basecoat's `data-variant` attribute, keyed by catalogue variant. */
  readonly dataVariants?: Readonly<Record<string, string | undefined>>;
}

export const BASECOAT_CLASSES: Readonly<Record<string, ComponentClasses>> = {
  Text: {
    base: "",
    variants: {
      body: "text-sm",
      h1: "text-2xl font-semibold tracking-tight",
      h2: "text-lg font-semibold",
      caption: "text-muted-foreground text-xs",
    },
  },

  // Layout uses SHELL-OWNED classes, not Tailwind utilities. 6a concluded
  // the prebuilt CDN bundle should ship with no build step, and that bundle
  // contains NO utilities -- so utility classes here would silently not
  // apply. Found only by rendering in a real browser (rung 7). A dozen
  // lines of the shell's own CSS keeps the zero-build path intact:
  //
  //   .shell-col   { display:flex; flex-direction:column; gap:.75rem }
  //   .shell-row   { display:flex; flex-direction:row; align-items:center; gap:.5rem }
  //   .shell-field { display:grid; gap:.375rem }
  Column: { base: "shell-col" },
  Row: { base: "shell-row" },

  // Basecoat styles a bare <hr>, so no class is needed. An empty string is
  // a real mapping, not a missing one -- see unmappedComponents().
  Divider: { base: "" },

  /**
   * MEASURED CORRECTION (rung 7). Basecoat 1.0 replaced composed variant
   * CLASSES with `data-variant` ATTRIBUTES:
   * `<button class="btn" data-variant="secondary">`.
   *
   * `btn-secondary` and friends DO NOT EXIST in the 1.0 bundles; they
   * survive only in the optional legacy `basecoat-css/compat` stylesheet.
   *
   * This is a better fit than the original mapping: the class stays
   * constant and the variant becomes an attribute, which is even less
   * class soup and matches how the catalogue already models variants.
   */
  Button: {
    base: "btn",
    dataVariants: {
      primary: undefined,          // omit the attribute for primary
      secondary: "secondary",
      danger: "destructive",
    },
  },

  TextField: {
    base: "shell-field",
    parts: {
      label: "label",
      input: "input",
    },
  },
};

/**
 * Catalogue components with no entry in the mapping.
 *
 * A non-empty result is the rejection signal for this rung.
 */
export function unmappedComponents(catalog: Catalog): string[] {
  return Object.keys(catalog.components).filter(
    (name) => BASECOAT_CLASSES[name] === undefined,
  );
}

/** Resolve the class list for a component, given its variant. */
export function classesFor(component: string, variant?: string): string {
  const def = BASECOAT_CLASSES[component];
  if (!def) return "";
  if (def.variants) {
    const chosen = def.variants[variant ?? ""] ?? def.variants["body"] ?? def.base;
    return chosen ?? "";
  }
  return def.base;
}

export function partClass(component: string, part: string): string {
  return BASECOAT_CLASSES[component]?.parts?.[part] ?? "";
}

/** Basecoat `data-variant` value for a catalogue variant, if any. */
export function dataVariantFor(
  component: string,
  variant?: string,
): string | undefined {
  const dv = BASECOAT_CLASSES[component]?.dataVariants;
  if (!dv || variant === undefined) return undefined;
  return dv[variant];
}
