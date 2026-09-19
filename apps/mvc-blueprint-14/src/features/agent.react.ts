import { activate as agentUiReact } from "@b/agent.ui.react";
import { activate as badgeUiReact } from "@b/badge.ui.react";
import { activate as catalogUiReact } from "@b/catalog.ui.react";
import type { FeatureManifest } from "@kernel";

export const uiCatalogReact: FeatureManifest = {
  id: "ui.catalog.react",
  requires: ["ui.catalog"],
  bundles: [{ id: "catalog.ui.react", activator: catalogUiReact }],
};

export const uiBadgeReact: FeatureManifest = {
  id: "ui.badge.react",
  requires: ["ui.badge", "ui.catalog.react"],
  bundles: [{ id: "badge.ui.react", activator: badgeUiReact }],
};

export const agentReact: FeatureManifest = {
  id: "agent.react",
  requires: ["agent", "ui.catalog.react"],
  bundles: [{ id: "agent.ui.react", activator: agentUiReact }],
};
