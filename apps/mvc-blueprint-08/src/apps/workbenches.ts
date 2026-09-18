import type { ApplicationManifest, FeatureManifest } from "@kernel";
import { contacts, hello, todos, todosContacts, todosStatusFeature } from "../features/logic.js";
import * as solid from "../features/solid.js";
import * as svelte from "../features/svelte.js";
import * as vue from "../features/vue.js";

/** One technology's UI features: the shell host plus the renderers of each app. */
export interface UiFeatures {
  readonly shell: FeatureManifest;
  readonly todos: FeatureManifest;
  readonly contacts: FeatureManifest;
  readonly hello: FeatureManifest;
}

export const technologies = {
  svelte: {
    shell: svelte.shellSvelteFeature,
    todos: svelte.todosSvelte,
    contacts: svelte.contactsSvelte,
    hello: svelte.helloSvelte,
  },
  solid: {
    shell: solid.shellSolidFeature,
    todos: solid.todosSolid,
    contacts: solid.contactsSolid,
    hello: solid.helloSolid,
  },
  vue: {
    shell: vue.shellVueFeature,
    todos: vue.todosVue,
    contacts: vue.contactsVue,
    hello: vue.helloVue,
  },
} satisfies Record<string, UiFeatures>;
export type Technology = keyof typeof technologies;

/** The full benchmark: both apps, the link, hello — P0's logic features, this technology's UI. */
export function workbench(tech: Technology): ApplicationManifest {
  const ui: UiFeatures = technologies[tech];
  return {
    id: `workbench.${tech}`,
    features: [
      ui.shell,
      todos,
      todosStatusFeature,
      ui.todos,
      contacts,
      ui.contacts,
      todosContacts,
      hello,
      ui.hello,
    ],
  };
}

/** Todos alone (no Contacts code is loaded). */
export function todosStandalone(tech: Technology): ApplicationManifest {
  const ui: UiFeatures = technologies[tech];
  return {
    id: `todos.standalone.${tech}`,
    features: [ui.shell, todos, todosStatusFeature, ui.todos],
  };
}

/** Contacts alone (no Todos code is loaded). */
export function contactsStandalone(tech: Technology): ApplicationManifest {
  const ui: UiFeatures = technologies[tech];
  return { id: `contacts.standalone.${tech}`, features: [ui.shell, contacts, ui.contacts] };
}
