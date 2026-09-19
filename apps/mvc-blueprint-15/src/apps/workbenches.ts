import type { ApplicationManifest, FeatureManifest } from "@kernel";
import { contacts, hello, todos, todosContacts, todosStatusFeature } from "../features/logic.js";
import { contactsJr, helloJr, todosJr } from "../features/jr.js";
import { jrReactFeature, shellReactFeature } from "../features/react.js";
import { jrSolidFeature, shellSolidFeature } from "../features/solid.js";

/** One technology: its shell host and its json-render renderer. The views are the same for all. */
export interface UiTechnology {
  readonly shell: FeatureManifest;
  readonly renderer: FeatureManifest;
}

export const technologies = {
  react: { shell: shellReactFeature, renderer: jrReactFeature },
  solid: { shell: shellSolidFeature, renderer: jrSolidFeature },
} satisfies Record<string, UiTechnology>;
export type Technology = keyof typeof technologies;

/** The full benchmark: P0's logic features, the shared json-render views, this technology. */
export function workbench(tech: Technology): ApplicationManifest {
  const ui: UiTechnology = technologies[tech];
  return {
    id: `workbench.${tech}`,
    features: [
      ui.shell,
      ui.renderer,
      todos,
      todosStatusFeature,
      todosJr,
      contacts,
      contactsJr,
      todosContacts,
      hello,
      helloJr,
    ],
  };
}

/** Todos alone (no Contacts code is loaded). */
export function todosStandalone(tech: Technology): ApplicationManifest {
  const ui: UiTechnology = technologies[tech];
  return {
    id: `todos.standalone.${tech}`,
    features: [ui.shell, ui.renderer, todos, todosStatusFeature, todosJr],
  };
}

/** Contacts alone (no Todos code is loaded). */
export function contactsStandalone(tech: Technology): ApplicationManifest {
  const ui: UiTechnology = technologies[tech];
  return {
    id: `contacts.standalone.${tech}`,
    features: [ui.shell, ui.renderer, contacts, contactsJr],
  };
}
