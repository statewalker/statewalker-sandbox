import type { ApplicationManifest } from "@kernel";
import { agentContacts, agentFeature, agentTodos, uiBadge, uiCatalog } from "../features/agent.js";
import { agentReact, uiBadgeReact, uiCatalogReact } from "../features/agent.react.js";
import { workbenchReact } from "./workbench.react.js";

/** P0's React workbench plus the J1 features: nothing of P0's manifest changes. */
export const workbenchAgent: ApplicationManifest = {
  id: "workbench.agent",
  features: [
    ...workbenchReact.features,
    uiCatalog,
    uiCatalogReact,
    uiBadge,
    uiBadgeReact,
    agentFeature,
    agentReact,
    agentTodos,
    agentContacts,
  ],
};
