import { activate as agent } from "@b/agent";
import { activate as agentContactsActions } from "@b/agent.contacts-actions";
import { activate as agentFixtures } from "@b/agent.fixtures";
import { activate as agentTodosActions } from "@b/agent.todos-actions";
import { activate as badge } from "@b/badge";
import { activate as catalog } from "@b/catalog";
import type { FeatureManifest } from "@kernel";

/** J1 logic features — technology-free. React features live in `features/agent.react.ts`. */

/** The catalog extension point's generic vocabulary (option c). Knows no agent. */
export const uiCatalog: FeatureManifest = {
  id: "ui.catalog",
  bundles: [{ id: "catalog", activator: catalog }],
};

/** One more component, from an independent feature. */
export const uiBadge: FeatureManifest = {
  id: "ui.badge",
  requires: ["ui.catalog"],
  bundles: [{ id: "badge", activator: badge }],
};

/** The agent: the generator (recorded fixtures unless the host set one) and the controller. */
export const agentFeature: FeatureManifest = {
  id: "agent",
  requires: ["ui.catalog"],
  bundles: [
    { id: "agent.fixtures", activator: agentFixtures, provides: ["agent:generator"] },
    { id: "agent", activator: agent, requires: ["agent:generator"] },
  ],
};

/** What Todos lets an agent do — contributed from outside Todos. */
export const agentTodos: FeatureManifest = {
  id: "agent.todos",
  requires: ["agent", "todos"],
  bundles: [{ id: "agent.todos-actions", activator: agentTodosActions }],
};

/** What Contacts lets an agent read and do — contributed from outside Contacts. */
export const agentContacts: FeatureManifest = {
  id: "agent.contacts",
  requires: ["agent", "contacts"],
  bundles: [{ id: "agent.contacts-actions", activator: agentContactsActions }],
};
