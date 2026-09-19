import type { FeatureManifest } from "@p5/kernel";
import { activate as contactsUiSolid } from "@p5/contacts.ui.solid";
import { activate as helloUiSolid } from "@p5/hello.ui.solid";
import { activate as shellSolid } from "@p5/shell.solid";
import { activate as todosUiSolid } from "@p5/todos.ui.solid";

export const shellSolidFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.solid",
      activator: shellSolid,
      requires: ["shell:root"],
      provides: ["shell:coverage"],
    },
  ],
};

export const todosSolid: FeatureManifest = {
  id: "todos.solid",
  requires: ["todos"],
  bundles: [{ id: "todos.ui.solid", activator: todosUiSolid }],
};

export const contactsSolid: FeatureManifest = {
  id: "contacts.solid",
  requires: ["contacts"],
  bundles: [{ id: "contacts.ui.solid", activator: contactsUiSolid }],
};

export const helloSolid: FeatureManifest = {
  id: "hello.solid",
  requires: ["hello"],
  bundles: [{ id: "hello.ui.solid", activator: helloUiSolid }],
};
