import * as contactsCore from "@p5/contacts.core";
import * as contactsEdit from "@p5/contacts.edit";
import * as contactsList from "@p5/contacts.list";
import * as todosClearCompleted from "@p5/todos.clear-completed";
import * as todosContactsLink from "@p5/todos.contacts-link";
import * as todosCore from "@p5/todos.core";
import * as todosEdit from "@p5/todos.edit";
import * as todosList from "@p5/todos.list";
import * as todosRename from "@p5/todos.rename";
import * as todosStatus from "@p5/todos.status";
import type { FeatureManifest } from "@p5/kernel";

/** Logic features — technology-free. UI features live in `features/<tech>.ts`. */

export const todos: FeatureManifest = {
  id: "todos",
  bundles: [
    { id: "todos.core", module: todosCore, provides: ["todos:api"] },
    { id: "todos.list", module: todosList },
    { id: "todos.edit", module: todosEdit },
    { id: "todos.clear-completed", module: todosClearCompleted },
    { id: "todos.rename", module: todosRename },
  ],
};

export const todosStatusFeature: FeatureManifest = {
  id: "todos.status",
  requires: ["todos"],
  bundles: [{ id: "todos.status", module: todosStatus }],
};

export const contacts: FeatureManifest = {
  id: "contacts",
  bundles: [
    { id: "contacts.core", module: contactsCore, provides: ["contacts:api"] },
    { id: "contacts.list", module: contactsList },
    { id: "contacts.edit", module: contactsEdit },
  ],
};

export const todosContacts: FeatureManifest = {
  id: "todos-contacts",
  requires: ["todos", "contacts"],
  bundles: [{ id: "todos.contacts-link", module: todosContactsLink }],
};

/** Lazy on purpose: how a bundle's code arrives is the loader's business. */
export const hello: FeatureManifest = {
  id: "hello",
  bundles: [{ id: "hello", module: () => import("@p5/hello") }],
};
