/** React UI feature manifests. */

import { contactsUiReactBundle } from "./bundles/contacts.ui.react/index.js";
import { shellReactBundle } from "./bundles/shell.react/index.js";
import { todosUiReactBundle } from "./bundles/todos.ui.react/index.js";
import type { FeatureManifest } from "./kernel/index.js";

export const shellReactFeature = (root: HTMLElement): FeatureManifest => ({
  id: "shell.react",
  requires: ["shell"],
  bundles: [shellReactBundle({ root })],
});
export const todosUiReactFeature: FeatureManifest = {
  id: "todos.ui.react",
  requires: ["todos", "shell.react"],
  bundles: [todosUiReactBundle],
};
export const contactsUiReactFeature: FeatureManifest = {
  id: "contacts.ui.react",
  requires: ["contacts", "shell.react"],
  bundles: [contactsUiReactBundle],
};
