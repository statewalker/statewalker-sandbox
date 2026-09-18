/** React UI features: the host and the renderers. Listed by applications beside the logic features. */
import { activate as contactsUi } from "./bundles/contacts.ui.react/index.ts";
import { activate as helloUi } from "./bundles/hello.ui.react/index.tsx";
import { activate as shellReact } from "./bundles/shell.react/index.tsx";
import { activate as todosUi } from "./bundles/todos.ui.react/index.ts";
import type { FeatureManifest } from "./kernel/index.ts";

export const shellReactFeature: FeatureManifest = {
  id: "shell.react",
  requires: ["shell"],
  bundles: [{ id: "shell.react", activator: shellReact }],
};
export const todosUiReactFeature: FeatureManifest = {
  id: "todos.ui.react",
  bundles: [{ id: "todos.ui.react", activator: todosUi }],
};
export const contactsUiReactFeature: FeatureManifest = {
  id: "contacts.ui.react",
  bundles: [{ id: "contacts.ui.react", activator: contactsUi }],
};
export const helloUiReactFeature: FeatureManifest = {
  id: "hello.ui.react",
  bundles: [{ id: "hello.ui.react", activator: helloUi }],
};
