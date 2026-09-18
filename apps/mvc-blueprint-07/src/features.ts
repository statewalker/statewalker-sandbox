import { activate as contactsCore } from "./bundles/contacts.core/index.js";
import { activate as contactsEdit } from "./bundles/contacts.edit/index.js";
import { activate as contactsList } from "./bundles/contacts.list/index.js";
import { activate as hello } from "./bundles/hello/index.js";
import { activate as shellNotifications } from "./bundles/shell.notifications/index.js";
import { activate as todosClearCompleted } from "./bundles/todos.clear-completed/index.js";
import { activate as todosContactsLink } from "./bundles/todos.contacts-link/index.js";
import { activate as todosCore } from "./bundles/todos.core/index.js";
import { activate as todosEdit } from "./bundles/todos.edit/index.js";
import { activate as todosList } from "./bundles/todos.list/index.js";
import { activate as todosStatus } from "./bundles/todos.status/index.js";
import type { Controller } from "./kernel/context.js";
import type { BundleManifest, FeatureManifest } from "./kernel/loader.js";

/** Feature manifests. UI bundles load lazily, so a headless application never loads React. */
const bundle = (id: string, activator: Controller): BundleManifest => ({ id, activator });
const lazy = (id: string, load: () => Promise<{ activate: Controller }>): BundleManifest => ({
  id,
  activator: { load: () => load().then((m) => m.activate) },
});

export const shell: FeatureManifest = {
  id: "shell",
  bundles: [bundle("shell.notifications", shellNotifications)],
};
export const shellReact: FeatureManifest = {
  id: "shell.react",
  requires: ["shell"],
  bundles: [lazy("shell.react", () => import("./bundles/shell.react/index.js"))],
};
export const todos: FeatureManifest = {
  id: "todos",
  requires: ["shell"],
  bundles: [
    bundle("todos.core", todosCore),
    bundle("todos.list", todosList),
    bundle("todos.edit", todosEdit),
    bundle("todos.clear-completed", todosClearCompleted),
    bundle("todos.status", todosStatus),
  ],
};
export const todosReact: FeatureManifest = {
  id: "todos.react",
  requires: ["todos", "shell.react"],
  bundles: [lazy("todos.ui.react", () => import("./bundles/todos.ui.react/index.js"))],
};
export const contacts: FeatureManifest = {
  id: "contacts",
  requires: ["shell"],
  bundles: [
    bundle("contacts.core", contactsCore),
    bundle("contacts.list", contactsList),
    bundle("contacts.edit", contactsEdit),
  ],
};
export const contactsReact: FeatureManifest = {
  id: "contacts.react",
  requires: ["contacts", "shell.react"],
  bundles: [lazy("contacts.ui.react", () => import("./bundles/contacts.ui.react/index.js"))],
};
export const todosContacts: FeatureManifest = {
  id: "todos-contacts",
  requires: ["todos", "contacts"],
  bundles: [bundle("todos.contacts-link", todosContactsLink)],
};
export const helloFeature: FeatureManifest = {
  id: "hello",
  requires: ["shell"],
  bundles: [bundle("hello", hello)],
};
export const helloReact: FeatureManifest = {
  id: "hello.react",
  requires: ["hello", "shell.react"],
  bundles: [lazy("hello.ui.react", () => import("./bundles/hello.ui.react/index.js"))],
};
