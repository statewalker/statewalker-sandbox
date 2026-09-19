import { activate as contactsCore } from "@p5/contacts.core";
import { activate as contactsEdit } from "@p5/contacts.edit";
import { activate as contactsList } from "@p5/contacts.list";
import { activate as todosClearCompleted } from "@p5/todos.clear-completed";
import { activate as todosContactsLink } from "@p5/todos.contacts-link";
import { activate as todosCore } from "@p5/todos.core";
import { activate as todosEdit } from "@p5/todos.edit";
import { activate as todosList } from "@p5/todos.list";
import { activate as todosStatus } from "@p5/todos.status";
import type { FeatureManifest } from "@p5/kernel";

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
    { id: "hello", lazy: true, activator: () => import("@p5/hello").then((m) => m.activate) },
  ],
};
