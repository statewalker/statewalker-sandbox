/** The applications of §14.5. */

import {
  contactsUiReactFeature,
  helloUiReactFeature,
  shellReactFeature,
  todosUiReactFeature,
} from "../features.react.ts";
import {
  contactsFeature,
  helloFeature,
  shellFeature,
  todosContactsFeature,
  todosFeature,
} from "../features.ts";
import type { ApplicationManifest } from "../kernel/index.ts";

export const workbenchReact: ApplicationManifest = {
  id: "workbench.react",
  features: [
    shellFeature,
    shellReactFeature,
    todosFeature,
    todosUiReactFeature,
    contactsFeature,
    contactsUiReactFeature,
    todosContactsFeature,
    helloFeature,
    helloUiReactFeature,
  ],
};
export const todosStandalone: ApplicationManifest = {
  id: "todos.standalone",
  features: [shellFeature, shellReactFeature, todosFeature, todosUiReactFeature],
};
export const contactsStandalone: ApplicationManifest = {
  id: "contacts.standalone",
  features: [shellFeature, shellReactFeature, contactsFeature, contactsUiReactFeature],
};
export const applications: Record<string, ApplicationManifest> = {
  "workbench.react": workbenchReact,
  "todos.standalone": todosStandalone,
  "contacts.standalone": contactsStandalone,
};
