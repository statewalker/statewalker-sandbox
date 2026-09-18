import type { ApplicationManifest } from "@kernel";
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
