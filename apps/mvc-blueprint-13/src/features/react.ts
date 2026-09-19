import * as contactsUiReact from "@p5/contacts.ui.react";
import * as helloUiReact from "@p5/hello.ui.react";
import * as shellReact from "@p5/shell.react";
import * as todosUiReact from "@p5/todos.ui.react";
import type { FeatureManifest } from "@p5/kernel";

export const shellReactFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.react",
      module: shellReact,
      requires: ["shell:root"],
      provides: ["shell:coverage"],
    },
  ],
};

export const todosReact: FeatureManifest = {
  id: "todos.react",
  requires: ["todos"],
  bundles: [{ id: "todos.ui.react", module: todosUiReact }],
};

export const contactsReact: FeatureManifest = {
  id: "contacts.react",
  requires: ["contacts"],
  bundles: [{ id: "contacts.ui.react", module: contactsUiReact }],
};

export const helloReact: FeatureManifest = {
  id: "hello.react",
  requires: ["hello"],
  bundles: [{ id: "hello.ui.react", module: helloUiReact }],
};
