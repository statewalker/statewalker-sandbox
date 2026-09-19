import type { ApplicationManifest } from "@p5/kernel";
import { contacts, hello, todos, todosContacts, todosStatusFeature } from "../features/logic.js";
import { contactsReact, helloReact, shellReactFeature, todosReact } from "../features/react.js";

export const workbenchReact: ApplicationManifest = {
  id: "workbench.react",
  features: [
    shellReactFeature,
    todos,
    todosStatusFeature,
    todosReact,
    contacts,
    contactsReact,
    todosContacts,
    hello,
    helloReact,
  ],
};

/** Todos alone. No Contacts code is loaded. */
export const todosReactStandalone: ApplicationManifest = {
  id: "todos.standalone.react",
  features: [shellReactFeature, todos, todosStatusFeature, todosReact],
};

/** Contacts alone. No Todos code is loaded. */
export const contactsReactStandalone: ApplicationManifest = {
  id: "contacts.standalone.react",
  features: [shellReactFeature, contacts, contactsReact],
};
