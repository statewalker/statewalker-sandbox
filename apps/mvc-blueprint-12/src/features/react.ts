import { activate as contactsUiReact } from "@b/contacts.ui.react";
import { activate as helloUiReact } from "@b/hello.ui.react";
import { activate as shellReact } from "@b/shell.react";
import { activate as todosUiReact } from "@b/todos.ui.react";
import type { FeatureManifest } from "@kernel";

export const shellReactFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.react",
      activator: shellReact,
      requires: ["shell:root"],
      provides: ["shell:coverage"],
    },
  ],
};

export const todosReact: FeatureManifest = {
  id: "todos.react",
  requires: ["todos"],
  bundles: [{ id: "todos.ui.react", activator: todosUiReact }],
};

export const contactsReact: FeatureManifest = {
  id: "contacts.react",
  requires: ["contacts"],
  bundles: [{ id: "contacts.ui.react", activator: contactsUiReact }],
};

export const helloReact: FeatureManifest = {
  id: "hello.react",
  requires: ["hello"],
  bundles: [{ id: "hello.ui.react", activator: helloUiReact }],
};
