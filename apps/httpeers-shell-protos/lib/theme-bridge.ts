/**
 * PROTOTYPE 7b — driving Dockview's theme from shadcn/Basecoat tokens.
 *
 * Dockview themes via ~125 of its own `--dv-*` CSS variables. Basecoat
 * carries the standard shadcn/ui semantic tokens: `--background`,
 * `--foreground`, `--primary`, `--muted`, `--border` and so on.
 *
 * THE QUESTION: can one drive the other, or must two palettes be maintained
 * in parallel? Two palettes would mean every theme change has to be made
 * twice, and would drift.
 *
 * ANSWER: one can drive the other. Both sides expose *semantic* variables
 * rather than hard-coded colours, so a bridge stylesheet is enough — no
 * JavaScript, no build step, no patching of Dockview's CSS.
 *
 * WHY A STYLESHEET AND NOT CODE. Dockview's own themes are JS objects
 * carrying a `className`, but the values behind that class are ordinary CSS
 * variables. Overriding them in a later stylesheet is the documented
 * cascade, not a hack, and it survives Dockview upgrades as long as the
 * variable names hold.
 *
 * COVERAGE IS TESTED AGAINST DOCKVIEW'S REAL CSS, not against this list.
 * The first version of this bridge covered 24 of 62 consumed semantic
 * variables while its hand-written coverage tests passed — a list can only
 * ever confirm its own assumptions.
 */

/**
 * The bridge. Every `--dv-*` value is a `var(--shadcn-token)` reference, so
 * changing the Basecoat style pack restyles the dock automatically.
 *
 * Dockview's per-theme palettes (`--dv-color-abyss-*`, `--dv-color-gh-*`
 * and the rest) are deliberately untouched: they belong to Dockview's own
 * bundled themes, which this REPLACES rather than extends.
 */
export const DOCKVIEW_SHADCN_BRIDGE = `
.dockview-theme-shadcn {
  /* surfaces */
  --dv-group-view-background-color: var(--background);
  --dv-tabs-and-actions-container-background-color: var(--card);
  --dv-activegroup-visiblepanel-tab-background-color: var(--background);
  --dv-activegroup-hiddenpanel-tab-background-color: var(--muted);
  --dv-inactivegroup-visiblepanel-tab-background-color: var(--background);
  --dv-inactivegroup-hiddenpanel-tab-background-color: var(--muted);

  /* text */
  --dv-activegroup-visiblepanel-tab-color: var(--foreground);
  --dv-activegroup-hiddenpanel-tab-color: var(--muted-foreground);
  --dv-inactivegroup-visiblepanel-tab-color: var(--muted-foreground);
  --dv-inactivegroup-hiddenpanel-tab-color: var(--muted-foreground);

  /* lines */
  --dv-separator-border: var(--border);
  --dv-tab-divider-color: var(--border);
  --dv-paneview-header-border-color: var(--border);

  /* interaction */
  --dv-active-sash-color: var(--ring);
  --dv-paneview-active-outline-color: var(--ring);
  --dv-drag-over-background-color: var(--accent);
  --dv-drag-over-border-color: var(--ring);
  --dv-icon-hover-background-color: var(--accent);

  /* drag-and-drop affordances -- the compass, edge indicators, guides */
  --dv-dnd-compass-color: var(--popover);
  --dv-dnd-compass-cell-color: var(--muted);
  --dv-dnd-compass-active-cell-color: var(--accent);
  --dv-dnd-compass-edge-cell-color: var(--muted);
  --dv-edge-dock-indicator-color: var(--ring);
  --dv-smart-guides-color: var(--ring);
  --dv-smart-guides-preview-color: var(--accent);
  --dv-drag-over-border: 1px dashed var(--ring);

  /* sashes and scrollbars */
  --dv-sash-color: var(--border);
  --dv-scrollbar-background-color: var(--muted);
  --dv-tabs-container-scrollbar-color: var(--muted-foreground);

  /* floating groups */
  --dv-floating-border: 1px solid var(--border);
  --dv-floating-group-border: 1px solid var(--border);
  --dv-floating-titlebar-border-bottom: 1px solid var(--border);
  --dv-floating-box-shadow: 0 8px 24px color-mix(in oklab, var(--foreground) 15%, transparent);

  /* tab grouping chips */
  --dv-tab-group-color: var(--muted-foreground);

  /* menus and overlays */
  --dv-context-menu-background-color: var(--popover);
  --dv-context-menu-color: var(--popover-foreground);
  --dv-floating-titlebar-background-color: var(--card);

  /* geometry — shadcn exposes a single radius */
  --dv-border-radius: var(--radius);
  --dv-tab-border-radius: var(--radius);
  --dv-dropdown-border-radius: var(--radius);
}
`;

/** The class the bridge defines. Apply to the dock host element. */
export const SHADCN_THEME_CLASS = "dockview-theme-shadcn";

/** Dockview variables the bridge covers. Asserted against Dockview's CSS. */
export const BRIDGED_VARIABLES: readonly string[] = [
  "--dv-group-view-background-color",
  "--dv-tabs-and-actions-container-background-color",
  "--dv-activegroup-visiblepanel-tab-background-color",
  "--dv-activegroup-hiddenpanel-tab-background-color",
  "--dv-inactivegroup-visiblepanel-tab-background-color",
  "--dv-inactivegroup-hiddenpanel-tab-background-color",
  "--dv-activegroup-visiblepanel-tab-color",
  "--dv-activegroup-hiddenpanel-tab-color",
  "--dv-inactivegroup-visiblepanel-tab-color",
  "--dv-inactivegroup-hiddenpanel-tab-color",
  "--dv-separator-border",
  "--dv-tab-divider-color",
  "--dv-paneview-header-border-color",
  "--dv-active-sash-color",
  "--dv-paneview-active-outline-color",
  "--dv-drag-over-background-color",
  "--dv-drag-over-border-color",
  "--dv-icon-hover-background-color",
  "--dv-context-menu-background-color",
  "--dv-context-menu-color",
  "--dv-floating-titlebar-background-color",
  "--dv-border-radius",
  "--dv-tab-border-radius",
  "--dv-dropdown-border-radius",
  "--dv-dnd-compass-color",
  "--dv-dnd-compass-cell-color",
  "--dv-dnd-compass-active-cell-color",
  "--dv-dnd-compass-edge-cell-color",
  "--dv-edge-dock-indicator-color",
  "--dv-smart-guides-color",
  "--dv-smart-guides-preview-color",
  "--dv-drag-over-border",
  "--dv-sash-color",
  "--dv-scrollbar-background-color",
  "--dv-tabs-container-scrollbar-color",
  "--dv-floating-border",
  "--dv-floating-group-border",
  "--dv-floating-titlebar-border-bottom",
  "--dv-floating-box-shadow",
  "--dv-tab-group-color",
];

/**
 * Dockview variables deliberately NOT bridged: metrics, timings and
 * z-indices. These are not colours and have no shadcn equivalent, so
 * mapping them would invent a correspondence that does not exist.
 * Dockview's own defaults apply.
 */
export const UNBRIDGED_BY_DESIGN: readonly string[] = [
  "--dv-active-sash-transition-delay",
  "--dv-active-sash-transition-duration",
  "--dv-floating-group-dragging-opacity",
  "--dv-floating-titlebar-height",
  "--dv-max-tab-rows",
  "--dv-overlay-z-index",
  "--dv-pinned-sticky-left",
  "--dv-sash-border-radius",
  "--dv-spacing-padding",
  "--dv-tab-close-icon-size",
  "--dv-tab-font-size",
  "--dv-tab-group-chip-border-radius",
  "--dv-tab-group-chip-font-size",
  "--dv-tab-group-chip-padding",
  "--dv-tab-group-line-opacity",
  "--dv-tab-margin",
  "--dv-tab-margin-block",
  "--dv-tab-margin-inline",
  "--dv-tabs-and-actions-container-font-size",
  "--dv-tabs-and-actions-container-height",
  "--dv-transition-duration",
  "--dv-wrap-vertical-tab-height",
];

/** The shadcn tokens the bridge depends on. */
export const REQUIRED_TOKENS: readonly string[] = [
  "--background",
  "--foreground",
  "--card",
  "--muted",
  "--muted-foreground",
  "--border",
  "--ring",
  "--accent",
  "--popover",
  "--popover-foreground",
  "--radius",
];

/** Install the bridge stylesheet into a document. */
export function installBridge(doc: Document = document): HTMLStyleElement {
  const style = doc.createElement("style");
  style.setAttribute("data-dockview-shadcn-bridge", "");
  style.textContent = DOCKVIEW_SHADCN_BRIDGE;
  doc.head.appendChild(style);
  return style;
}
