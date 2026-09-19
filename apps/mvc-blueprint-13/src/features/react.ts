import { activate as contactsUiReact } from "@p5/contacts.ui.react";
import { activate as helloUiReact } from "@p5/hello.ui.react";
import { activate as shellReact } from "@p5/shell.react";
import { activate as todosUiReact } from "@p5/todos.ui.react";
import type { FeatureManifest } from "@p5/kernel";

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
