import {
  contacts,
  contactsReact,
  helloFeature,
  helloReact,
  shell,
  shellReact,
  todos,
  todosContacts,
  todosReact,
} from "../features.js";
import type { ApplicationManifest } from "../kernel/loader.js";

export const workbenchReact: ApplicationManifest = {
  id: "workbench.react",
  features: [
    shell,
    shellReact,
    todos,
    todosReact,
    contacts,
    contactsReact,
    todosContacts,
    helloFeature,
    helloReact,
  ],
};
export const todosStandalone: ApplicationManifest = {
  id: "todos.standalone",
  features: [shell, shellReact, todos, todosReact],
};
export const contactsStandalone: ApplicationManifest = {
  id: "contacts.standalone",
  features: [shell, shellReact, contacts, contactsReact],
};

const REACT = new Set(["shell.react", "todos.react", "contacts.react", "hello.react"]);

/** The same application with no UI technology — what node tests run. */
export const headless = (app: ApplicationManifest): ApplicationManifest => ({
  id: `${app.id}.headless`,
  features: app.features.filter((f) => !REACT.has(f.id)),
});

/** Removal runs (§13.3): the application without these features, or without these bundles. */
export const without = (app: ApplicationManifest, ids: readonly string[]): ApplicationManifest => ({
  id: `${app.id}-without-${ids.join("+")}`,
  features: app.features
    .filter((f) => !ids.includes(f.id))
    .map((f) => ({ ...f, bundles: f.bundles.filter((b) => !ids.includes(b.id)) })),
});
