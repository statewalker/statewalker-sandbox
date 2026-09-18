/** The React applications: workbench.react, todos.standalone, contacts.standalone. */

import type { LogicOptions } from "../features.js";
import {
  contactsUiReactFeature,
  shellReactFeature,
  todosUiReactFeature,
} from "../features.react.js";
import type { ApplicationManifest } from "../kernel/index.js";
import { contactsHeadless, todosHeadless, workbenchHeadless } from "./index.js";

const withReact = (
  app: ApplicationManifest,
  id: string,
  root: HTMLElement,
): ApplicationManifest => {
  const has = (f: string) => app.features.some((x) => x.id === f);
  return {
    id,
    features: [
      ...app.features,
      shellReactFeature(root),
      ...(has("todos") ? [todosUiReactFeature] : []),
      ...(has("contacts") ? [contactsUiReactFeature] : []),
    ],
  };
};

export const workbenchReact = (root: HTMLElement, o: LogicOptions = {}) =>
  withReact(workbenchHeadless(o), "workbench.react", root);
export const todosStandalone = (root: HTMLElement, o: LogicOptions = {}) =>
  withReact(todosHeadless(o), "todos.standalone", root);
export const contactsStandalone = (root: HTMLElement, o: LogicOptions = {}) =>
  withReact(contactsHeadless(o), "contacts.standalone", root);
