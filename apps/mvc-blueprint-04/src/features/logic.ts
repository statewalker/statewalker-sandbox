import { activate as contactsCore } from "@b/contacts.core";
import { activate as contactsEdit } from "@b/contacts.edit";
import { activate as contactsList } from "@b/contacts.list";
import { activate as todosClearCompleted } from "@b/todos.clear-completed";
import { activate as todosContactsLink } from "@b/todos.contacts-link";
import { activate as todosCore } from "@b/todos.core";
import { activate as todosEdit } from "@b/todos.edit";
import { activate as todosList } from "@b/todos.list";
import { activate as todosStatus } from "@b/todos.status";
import type { FeatureManifest } from "@kernel";

/** Logic features — technology-free. UI features live in `features/<tech>.ts`. */

export const todos: FeatureManifest = {
  id: "todos",
  bundles: [
    { id: "todos.core", activator: todosCore, provides: ["todos:api"] },
    { id: "todos.list", activator: todosList },
    { id: "todos.edit", activator: todosEdit },
    { id: "todos.clear-completed", activator: todosClearCompleted },
  ],
};

export const todosStatusFeature: FeatureManifest = {
  id: "todos.status",
  requires: ["todos"],
  bundles: [{ id: "todos.status", activator: todosStatus }],
};

export const contacts: FeatureManifest = {
  id: "contacts",
  bundles: [
    { id: "contacts.core", activator: contactsCore, provides: ["contacts:api"] },
    { id: "contacts.list", activator: contactsList },
    { id: "contacts.edit", activator: contactsEdit },
  ],
};

export const todosContacts: FeatureManifest = {
  id: "todos-contacts",
  requires: ["todos", "contacts"],
  bundles: [{ id: "todos.contacts-link", activator: todosContactsLink }],
};

/** Lazy on purpose: how a bundle's code arrives is the loader's business. */
export const hello: FeatureManifest = {
  id: "hello",
  bundles: [
    { id: "hello", lazy: true, activator: () => import("@b/hello").then((m) => m.activate) },
  ],
};
