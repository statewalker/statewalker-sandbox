import { activate as jrSolid } from "@b/jr.solid";
import { activate as shellSolid } from "@b/shell.solid";
import type { FeatureManifest } from "@kernel";

/**
 * Solid: the shell host (U1's, unchanged) and json-render's Solid renderer (catalog + bridge). A
 * module of its own: `@json-render/solid` cannot be imported under Node (it calls a client-only
 * Solid API at module evaluation), so node tests must never reach it.
 */

export const shellSolidFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.solid",
      activator: shellSolid,
      requires: ["shell:root"],
      provides: ["shell:coverage"],
    },
  ],
};

export const jrSolidFeature: FeatureManifest = {
  id: "jr.solid",
  bundles: [{ id: "jr.solid", activator: jrSolid }],
};
