import type { ApplicationManifest } from "@kernel";
import { contacts, hello, todos, todosContacts, todosStatusFeature } from "../features/logic.js";
import { shellTestFeature, type Technology, technologies } from "../features/tech.js";
import { contactsSpecs, helloSpecs, todosSpecs } from "../features/ui.js";

/** The full benchmark: P0's logic features, the shared specs, one technology's host + interpreter. */
export function workbench(tech: Technology): ApplicationManifest {
  const ui = technologies[tech];
  return {
    id: `workbench.${tech}`,
    features: [
      ui.shell,
      ui.interpreter,
      todos,
      todosStatusFeature,
      todosSpecs,
      contacts,
      contactsSpecs,
      todosContacts,
      hello,
      helloSpecs,
    ],
  };
}

/** Todos alone (no Contacts code is loaded), in the trivial test shell. */
export const todosStandalone: ApplicationManifest = {
  id: "todos.standalone",
  features: [shellTestFeature, technologies.dom.interpreter, todos, todosStatusFeature, todosSpecs],
};

/** Contacts alone (no Todos code is loaded), in the trivial test shell. */
export const contactsStandalone: ApplicationManifest = {
  id: "contacts.standalone",
  features: [shellTestFeature, technologies.dom.interpreter, contacts, contactsSpecs],
};
