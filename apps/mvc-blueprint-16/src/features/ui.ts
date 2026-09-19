import { activate as contactsUiSpec } from "@b/contacts.ui.spec";
import { activate as helloUiSpec } from "@b/hello.ui.spec";
import { activate as todosUiSpec } from "@b/todos.ui.spec";
import type { FeatureManifest } from "@kernel";

/** The views, as technology-neutral specs: one UI feature per app, for every technology. */

export const todosSpecs: FeatureManifest = {
  id: "todos.ui",
  requires: ["todos"],
  bundles: [{ id: "todos.ui.spec", activator: todosUiSpec }],
};
export const contactsSpecs: FeatureManifest = {
  id: "contacts.ui",
  requires: ["contacts"],
  bundles: [{ id: "contacts.ui.spec", activator: contactsUiSpec }],
};
export const helloSpecs: FeatureManifest = {
  id: "hello.ui",
  requires: ["hello"],
  bundles: [{ id: "hello.ui.spec", activator: helloUiSpec }],
};
