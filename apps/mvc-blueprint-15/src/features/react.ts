import { activate as jrReact } from "@b/jr.react";
import { activate as shellReact } from "@b/shell.react";
import type { FeatureManifest } from "@kernel";

/** React: the shell host (P0's, unchanged) and json-render's React renderer (catalog + bridge). */

export const shellReactFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.react",
      activator: shellReact,
      requires: ["shell:root"],
      provides: ["shell:coverage"],
    },
  ],
};

export const jrReactFeature: FeatureManifest = {
  id: "jr.react",
  bundles: [{ id: "jr.react", activator: jrReact }],
};
