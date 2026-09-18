/** Logic feature manifests (technology-neutral). UI features are in `features.react.ts`. */

import { activate as contactsCore } from "./bundles/contacts.core/index.ts";
import { activate as contactsEdit } from "./bundles/contacts.edit/index.ts";
import { activate as contactsList } from "./bundles/contacts.list/index.ts";
import { activate as hello } from "./bundles/hello/index.ts";
import { activate as shellCore } from "./bundles/shell.core/index.ts";
import { activate as todosClearCompleted } from "./bundles/todos.clear-completed/index.ts";
import { activate as todosContactsLink } from "./bundles/todos.contacts-link/index.ts";
import { activate as todosCore } from "./bundles/todos.core/index.ts";
import { activate as todosEdit } from "./bundles/todos.edit/index.ts";
import { activate as todosList } from "./bundles/todos.list/index.ts";
import { activate as todosStatus } from "./bundles/todos.status/index.ts";
import type { FeatureManifest } from "./kernel/index.ts";

export const shellFeature: FeatureManifest = {
  id: "shell",
  bundles: [{ id: "shell.core", activator: shellCore }],
};
export const todosFeature: FeatureManifest = {
  id: "todos",
  requires: ["shell"],
  bundles: [
    { id: "todos.core", activator: todosCore },
    { id: "todos.list", activator: todosList },
    { id: "todos.edit", activator: todosEdit },
    { id: "todos.clear-completed", activator: todosClearCompleted },
    { id: "todos.status", activator: todosStatus },
  ],
};
export const contactsFeature: FeatureManifest = {
  id: "contacts",
  requires: ["shell"],
  bundles: [
    { id: "contacts.core", activator: contactsCore },
    { id: "contacts.list", activator: contactsList },
    { id: "contacts.edit", activator: contactsEdit },
  ],
};
export const todosContactsFeature: FeatureManifest = {
  id: "todos-contacts",
  requires: ["todos", "contacts"],
  bundles: [{ id: "todos.contacts-link", activator: todosContactsLink }],
};
export const helloFeature: FeatureManifest = {
  id: "hello",
  requires: ["shell"],
  bundles: [{ id: "hello", activator: hello }],
};
