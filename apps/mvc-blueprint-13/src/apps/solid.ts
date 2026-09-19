import type { ApplicationManifest } from "@p5/kernel";
import { contacts, hello, todos, todosContacts, todosStatusFeature } from "../features/logic.js";
import { contactsSolid, helloSolid, shellSolidFeature, todosSolid } from "../features/solid.js";

export const workbenchSolid: ApplicationManifest = {
  id: "workbench.solid",
  features: [
    shellSolidFeature,
    todos,
    todosStatusFeature,
    todosSolid,
    contacts,
    contactsSolid,
    todosContacts,
    hello,
    helloSolid,
  ],
};

/** Todos alone. No Contacts code is loaded. */
export const todosSolidStandalone: ApplicationManifest = {
  id: "todos.standalone.solid",
  features: [shellSolidFeature, todos, todosStatusFeature, todosSolid],
};

/** Contacts alone. No Todos code is loaded. */
export const contactsSolidStandalone: ApplicationManifest = {
  id: "contacts.standalone.solid",
  features: [shellSolidFeature, contacts, contactsSolid],
};
