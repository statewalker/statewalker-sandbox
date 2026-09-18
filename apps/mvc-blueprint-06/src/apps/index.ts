/** The applications (§14.5): manifests only. */
import {
  contactsFeature,
  type LogicOptions,
  logicFeatures,
  shellFeature,
  todosFeature,
  todosStatusFeature,
} from "../features.js";
import type { ApplicationManifest } from "../kernel/index.js";

/** The workbench without any UI technology: what node tests run (the headless test shell). */
export const workbenchHeadless = (o: LogicOptions = {}): ApplicationManifest => ({
  id: "workbench.headless",
  features: logicFeatures(o),
});
export const todosHeadless = (o: LogicOptions = {}): ApplicationManifest => ({
  id: "todos.headless",
  features: [shellFeature, todosFeature(o), todosStatusFeature],
});
export const contactsHeadless = (o: LogicOptions = {}): ApplicationManifest => ({
  id: "contacts.headless",
  features: [shellFeature, contactsFeature(o)],
});
