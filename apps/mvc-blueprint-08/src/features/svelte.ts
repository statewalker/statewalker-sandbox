import { activate as contactsUiSvelte } from "@b/contacts.ui.svelte";
import { activate as helloUiSvelte } from "@b/hello.ui.svelte";
import { activate as shellSvelte } from "@b/shell.svelte";
import { activate as todosUiSvelte } from "@b/todos.ui.svelte";
import type { FeatureManifest } from "@kernel";

export const shellSvelteFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.svelte",
      activator: shellSvelte,
      requires: ["shell:root"],
      provides: ["shell:coverage"],
    },
  ],
};

export const todosSvelte: FeatureManifest = {
  id: "todos.svelte",
  requires: ["todos"],
  bundles: [{ id: "todos.ui.svelte", activator: todosUiSvelte }],
};

export const contactsSvelte: FeatureManifest = {
  id: "contacts.svelte",
  requires: ["contacts"],
  bundles: [{ id: "contacts.ui.svelte", activator: contactsUiSvelte }],
};

export const helloSvelte: FeatureManifest = {
  id: "hello.svelte",
  requires: ["hello"],
  bundles: [{ id: "hello.ui.svelte", activator: helloUiSvelte }],
};
