import { activate as contactsUiJr } from "@b/contacts.ui.jr";
import { activate as helloUiJr } from "@b/hello.ui.jr";
import { activate as todosUiJr } from "@b/todos.ui.jr";
import type { FeatureManifest } from "@kernel";

/** The views as json-render specs + model bindings: once, for every technology. */

export const todosJr: FeatureManifest = {
  id: "todos.jr",
  requires: ["todos"],
  bundles: [{ id: "todos.ui.jr", activator: todosUiJr }],
};

export const contactsJr: FeatureManifest = {
  id: "contacts.jr",
  requires: ["contacts"],
  bundles: [{ id: "contacts.ui.jr", activator: contactsUiJr }],
};

export const helloJr: FeatureManifest = {
  id: "hello.jr",
  requires: ["hello"],
  bundles: [{ id: "hello.ui.jr", activator: helloUiJr }],
};
