import { activate as contactsUiVue } from "@b/contacts.ui.vue";
import { activate as helloUiVue } from "@b/hello.ui.vue";
import { activate as shellVue } from "@b/shell.vue";
import { activate as todosUiVue } from "@b/todos.ui.vue";
import type { FeatureManifest } from "@kernel";

export const shellVueFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.vue",
      activator: shellVue,
      requires: ["shell:root"],
      provides: ["shell:coverage"],
    },
  ],
};

export const todosVue: FeatureManifest = {
  id: "todos.vue",
  requires: ["todos"],
  bundles: [{ id: "todos.ui.vue", activator: todosUiVue }],
};

export const contactsVue: FeatureManifest = {
  id: "contacts.vue",
  requires: ["contacts"],
  bundles: [{ id: "contacts.ui.vue", activator: contactsUiVue }],
};

export const helloVue: FeatureManifest = {
  id: "hello.vue",
  requires: ["hello"],
  bundles: [{ id: "hello.ui.vue", activator: helloUiVue }],
};
