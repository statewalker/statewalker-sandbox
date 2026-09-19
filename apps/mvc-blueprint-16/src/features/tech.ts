import { activate as shellDom } from "@b/shell.dom";
import { activate as shellSolid } from "@b/shell.solid";
import { activate as shellTestDom } from "@b/shell.test/dom";
import { activate as uiDomSpec } from "@b/ui.dom.spec";
import { activate as uiSolidSpec } from "@b/ui.solid.spec";
import type { FeatureManifest } from "@kernel";

/** A UI technology is a shell host plus its spec interpreter; the specs are shared (`ui.ts`). */
const shell = (id: string, host: FeatureManifest["bundles"][number]["activator"]) => ({
  id: "shell",
  bundles: [{ id, activator: host, requires: ["shell:root"], provides: ["shell:coverage"] }],
});

/** A UI technology: its shell host and its interpreter. */
export const technologies = {
  dom: {
    shell: shell("shell.dom", shellDom),
    interpreter: { id: "ui.dom", bundles: [{ id: "ui.dom.spec", activator: uiDomSpec }] },
  },
  solid: {
    shell: shell("shell.solid", shellSolid),
    interpreter: { id: "ui.solid", bundles: [{ id: "ui.solid.spec", activator: uiSolidSpec }] },
  },
} satisfies Record<string, { shell: FeatureManifest; interpreter: FeatureManifest }>;
export type Technology = keyof typeof technologies;

/** The trivial test shell (DOM), for the standalone runs; it renders through the DOM interpreter. */
export const shellTestFeature: FeatureManifest = shell("shell.test", shellTestDom);
