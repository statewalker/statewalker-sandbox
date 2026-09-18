import type { ApplicationManifest } from "@kernel";
import { contactsDom, helloDom, shellDomFeature, todosDom } from "../features/dom.js";
import { contacts, hello, todos, todosContacts, todosStatusFeature } from "../features/logic.js";

export const workbenchDom: ApplicationManifest = {
  id: "workbench.dom",
  features: [
    shellDomFeature,
    todos,
    todosStatusFeature,
    todosDom,
    contacts,
    contactsDom,
    todosContacts,
    hello,
    helloDom,
  ],
};
