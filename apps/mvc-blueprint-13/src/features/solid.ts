import type { FeatureManifest } from "@p5/kernel";
import * as contactsUiSolid from "@p5/contacts.ui.solid";
import * as helloUiSolid from "@p5/hello.ui.solid";
import * as shellSolid from "@p5/shell.solid";
import * as todosUiSolid from "@p5/todos.ui.solid";

export const shellSolidFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.solid",
      module: shellSolid,
      requires: ["shell:root"],
      provides: ["shell:coverage"],
    },
  ],
};

export const todosSolid: FeatureManifest = {
  id: "todos.solid",
  requires: ["todos"],
  bundles: [{ id: "todos.ui.solid", module: todosUiSolid }],
};

export const contactsSolid: FeatureManifest = {
  id: "contacts.solid",
  requires: ["contacts"],
  bundles: [{ id: "contacts.ui.solid", module: contactsUiSolid }],
};

export const helloSolid: FeatureManifest = {
  id: "hello.solid",
  requires: ["hello"],
  bundles: [{ id: "hello.ui.solid", module: helloUiSolid }],
};
